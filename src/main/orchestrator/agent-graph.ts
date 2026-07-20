import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { AgentRuntimeError } from "./agent-runtime-error";
import type { ToolCallResult } from "./types";
import type { ChatMessage } from "./vendors/types";

export type ActionDecision =
  | {
      decision: "act";
      capability: string;
      objective: string;
      targetRefs: string[];
      /** 本次工具成功后的继续策略。未声明时默认 respond。 */
      afterSuccess?: "respond" | "replan";
    }
  | {
      decision: "respond";
      reason: string;
    }
  | {
      decision: "ask_user";
      reason: string;
      missingInformation: string[];
    };

export type ActDecision = Extract<ActionDecision, { decision: "act" }>;

export interface AgentGraphInput {
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  messages: ChatMessage[];
  availableCapabilities: string[];
}

export interface AgentGraphState extends AgentGraphInput {
  decision?: ActionDecision;
  /** 当前正在执行的 act 决策（含 afterSuccess），供 routeAfterTool 读取。 */
  currentAction?: ActDecision;
  toolResults: ToolCallResult[];
  iterationCount: number;
  reply: string;
}

export interface AgentGraphDeps {
  decide: (state: AgentGraphState) => Promise<ActionDecision>;
  execute: (state: AgentGraphState, decision: ActDecision) => Promise<ToolCallResult[]>;
  respond: (state: AgentGraphState, decision: Exclude<ActionDecision, { decision: "act" }>) => Promise<string>;
  maxIterations?: number;
  trace?: (node: string, state: AgentGraphState) => void;
}

const GraphState = Annotation.Root({
  originalQuery: Annotation<string>,
  contextualizedQuery: Annotation<string>,
  citaContextBlock: Annotation<string>,
  messages: Annotation<ChatMessage[]>,
  availableCapabilities: Annotation<string[]>,
  decision: Annotation<ActionDecision | undefined>,
  currentAction: Annotation<ActDecision | undefined>,
  toolResults: Annotation<ToolCallResult[]>,
  iterationCount: Annotation<number>,
  reply: Annotation<string>,
});

export async function runAgentGraph(input: AgentGraphInput, deps: AgentGraphDeps): Promise<AgentGraphState> {
  const maxIterations = Math.max(1, deps.maxIterations ?? 12);

  const graph = new StateGraph(GraphState)
    .addNode("decide", async (state) => {
      deps.trace?.("decide", state);
      const decision = await deps.decide(state);
      // act decision 同步写入 currentAction，供 routeAfterTool 读取 afterSuccess
      return {
        decision,
        ...(decision.decision === "act" ? { currentAction: decision } : {}),
      };
    })
    .addNode("execute", async (state) => {
      deps.trace?.("execute", state);
      if (state.iterationCount >= maxIterations) {
        throw new AgentRuntimeError(
          "E_AGENT_GRAPH_ITERATION_LIMIT",
          `Agent graph exceeded ${maxIterations} iterations.`,
        );
      }
      if (state.decision?.decision !== "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_ACT_STATE");
      }
      const results = await deps.execute(state, state.decision);
      return {
        toolResults: [...state.toolResults, ...results],
        iterationCount: state.iterationCount + 1,
      };
    })
    .addNode("routeAfterTool", async (state) => {
      deps.trace?.("routeAfterTool", state);
      const result = state.toolResults[state.toolResults.length - 1];
      const action = state.currentAction;
      if (!result || !action) {
        // 理论上不会发生；兜底回 decide
        return new Command({ goto: "decide" });
      }

      // 路由逻辑（纯代码，不调 LLM）
      let goto: "decide" | "soul";
      if (result.status === "failed") {
        goto = result.retryable ? "decide" : "soul";
      } else if (!result.terminal) {
        goto = "decide";
      } else {
        // succeeded + terminal：按声明的 afterSuccess 路由
        goto = action.afterSuccess === "replan" ? "decide" : "soul";
      }

      // 去 soul 时把 decision 改写成 respond，让 Soul 逻辑不用改
      const update = goto === "soul"
        ? { decision: { decision: "respond" as const, reason: "tool_complete" } }
        : {};
      return new Command({ update, goto });
    })
    .addNode("soul", async (state) => {
      deps.trace?.("soul", state);
      if (!state.decision || state.decision.decision === "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_SOUL_STATE");
      }
      return { reply: await deps.respond(state, state.decision) };
    })
    .addEdge(START, "decide")
    .addConditionalEdges("decide", (state) => state.decision?.decision === "act" ? "execute" : "soul")
    .addEdge("execute", "routeAfterTool")
    .addEdge("soul", END)
    .compile();

  return await graph.invoke({
    ...input,
    decision: undefined,
    currentAction: undefined,
    toolResults: [],
    iterationCount: 0,
    reply: "",
  }, {
    // decide + execute + routeAfterTool 消耗三个 superstep 每个动作循环。
    // 保持 LangGraph 自己的递归保护在域特定迭代错误之后。
    recursionLimit: maxIterations * 3 + 6,
  });
}
