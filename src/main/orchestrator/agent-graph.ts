import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { ToolCallResult } from "./types";
import type { ChatMessage } from "./vendors/types";

export type ActionDecision =
  | {
      decision: "act";
      capability: string;
      objective: string;
      targetRefs: string[];
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

export interface AgentGraphInput {
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  messages: ChatMessage[];
  availableCapabilities: string[];
}

export interface AgentGraphState extends AgentGraphInput {
  decision?: ActionDecision;
  toolResults: ToolCallResult[];
  iterationCount: number;
  reply: string;
}

export interface AgentGraphDeps {
  decide: (state: AgentGraphState) => Promise<ActionDecision>;
  execute: (state: AgentGraphState, decision: Extract<ActionDecision, { decision: "act" }>) => Promise<ToolCallResult[]>;
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
  toolResults: Annotation<ToolCallResult[]>,
  iterationCount: Annotation<number>,
  reply: Annotation<string>,
});

export async function runAgentGraph(input: AgentGraphInput, deps: AgentGraphDeps): Promise<AgentGraphState> {
  const maxIterations = Math.max(1, deps.maxIterations ?? 12);

  const graph = new StateGraph(GraphState)
    .addNode("decide", async (state) => {
      deps.trace?.("decide", state);
      return { decision: await deps.decide(state) };
    })
    .addNode("execute", async (state) => {
      deps.trace?.("execute", state);
      if (state.iterationCount >= maxIterations) {
        throw new Error("E_AGENT_GRAPH_ITERATION_LIMIT");
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
    .addNode("soul", async (state) => {
      deps.trace?.("soul", state);
      if (!state.decision || state.decision.decision === "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_SOUL_STATE");
      }
      return { reply: await deps.respond(state, state.decision) };
    })
    .addEdge(START, "decide")
    .addConditionalEdges("decide", (state) => state.decision?.decision === "act" ? "execute" : "soul")
    .addEdge("execute", "decide")
    .addEdge("soul", END)
    .compile();

  return await graph.invoke({
    ...input,
    decision: undefined,
    toolResults: [],
    iterationCount: 0,
    reply: "",
  }, {
    // decide + execute consume two supersteps per action. Keep LangGraph's own
    // recursion guard behind our domain-specific iteration error.
    recursionLimit: maxIterations * 2 + 4,
  });
}
