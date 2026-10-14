import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { decide, parseObservation, type Observation } from "../plugins/dungeons-decision/src/policy";
import { DecisionSession } from "../plugins/dungeons-decision/src/session";
import { example, scenarios } from "../plugins/dungeons-decision/src/scenarios";
import { createPlugin } from "../plugins/dungeons-decision/src/index";

const now = 10000;
function observation(id = "idle", time = now) { return example(id, time); }
function result(edit: (o: Observation) => void, scenario = "idle") {
  const o = observation(scenario); edit(o); return decide(parseObservation(o), now);
}
describe("Dungeons companion choices", () => {
  it.each(scenarios)("$name => $expected", scenario => {
    const decision = decide(parseObservation(observation(scenario.id)), now);
    expect(decision.action).toBe(scenario.expected);
    expect(decision.durationMs).toBeLessThanOrEqual(400);
  });
  it.each(["menu", "loading", "unknown"] as const)("never acts in %s", scene => {
    expect(result(o => { o.scene = scene; }, "melee").action).toBe("release");
  });
  it("releases on foreground loss even with an available heal", () => {
    expect(result(o => { o.foreground = false; }, "heal").action).toBe("release");
  });
  it.each([8499, 10001])("rejects stale or future observations at %d", time => {
    expect(decide(observation("melee", time), now).action).toBe("release");
  });
  it.each(["health", "downed", "position"] as const)("unknown own %s stops movement", key => {
    expect(result(o => { o.self[key] = null as never; }, "follow").action).toBe("release");
  });
  it("unknown danger never causes an attack", () => {
    expect(result(o => { o.imminentDanger = null; }, "melee").action).toBe("release");
  });
  it("imminent danger preempts low-health heal and attack", () => {
    const d = result(o => { o.imminentDanger = true; o.enemy = observation("melee").enemy; }, "heal");
    expect(d.action).toBe("dodge"); expect(d.target).toEqual({ x: 0.4, y: 0.5 });
  });
  it("cannot dodge across an unknown route or invent an escape", () => {
    expect(result(o => { o.paths.escape = null; }, "dodge").action).toBe("release");
    expect(result(o => { o.escape = null; }, "dodge").action).toBe("release");
  });
  it("unavailable dodge uses only an explicitly safe retreat", () => {
    expect(result(o => { o.self.dodgeReady = null; }, "dodge").action).toBe("retreat");
  });
  it("low health preempts nearby enemy attacks", () => {
    expect(result(o => { o.enemy = observation("melee").enemy; }, "heal").action).toBe("heal");
    expect(result(o => { o.self.health = 0.2; o.self.potionReady = null; }, "idle").action).toBe("wait");
  });
  it("never treats a nearby screen point as confirmed melee reach", () => {
    expect(result(o => { o.enemy!.meleeReach = null; }, "melee").action).toBe("wait");
  });
  it.each([0, null])("does not fire with arrows %s", arrows => {
    expect(result(o => { o.arrows = arrows; }, "ranged").action).toBe("wait");
  });
  it("does not fire down an unknown sightline", () => {
    expect(result(o => { o.enemy!.clearShot = null; }, "ranged").action).toBe("wait");
  });
  it("regroups instead of chasing a distant enemy", () => {
    expect(result(o => { o.enemy = observation("ranged").enemy; }, "follow").action).toBe("follow");
  });
  it("defends against a confirmed immediate melee threat while regrouping", () => {
    expect(result(o => { o.enemy = observation("melee").enemy; }, "follow").action).toBe("melee");
  });
  it("missing bound leader does not reuse a previous position", () => {
    expect(result(o => { o.leader.position = null; }, "melee").action).toBe("release");
  });
  it("requires safe rescue and confirmed on-screen revive prompt", () => {
    expect(result(o => { o.enemy = observation("melee").enemy; }, "revive").action).toBe("wait");
    expect(result(o => { o.leader.reviveAvailable = null; }, "revive").action).toBe("wait");
    expect(result(o => { o.self.health = 0.5; }, "revive").action).toBe("wait");
    expect(result(o => { o.leader.position = { x: 0.8, y: 0.5 }; }, "revive").action).toBe("follow");
  });
});
describe("Observation boundary", () => {
  it.each([
    (o: any) => { o.self.health = NaN; }, (o: any) => { o.self.health = 1.1; },
    (o: any) => { o.self.position.x = Infinity; }, (o: any) => { o.self.position.y = -0.1; },
    (o: any) => { delete o.imminentDanger; }, (o: any) => { o.source = "verified-game"; },
    (o: any) => { o.arrows = 1.5; }, (o: any) => { o.capturedAt = "now"; },
  ])("rejects malformed observations", edit => {
    const o = observation(); edit(o); expect(() => parseObservation(o)).toThrow();
  });
  it("preserves unknown states and discards unsolicited controls", () => {
    const o = observation() as any; o.self.potionReady = null; o.pad = 1; o.control = "A";
    expect(parseObservation(o).self.potionReady).toBeNull(); expect(parseObservation(o)).not.toHaveProperty("pad");
  });
});
describe("Single proposal and simulation feedback", () => {
  it("never stacks an unacknowledged action", () => {
    const s = new DecisionSession(), first = s.preview(observation("melee"), now);
    expect(s.preview(observation("melee", now + 1), now + 1).action).toBe("wait");
    expect(s.status().pending!.id).toBe(first.id);
    expect(first).toMatchObject({ actor: "companion", simulationOnly: true, gameInputSent: false, gameOutcomeVerified: false });
  });
  it("safety stop cancels an earlier attack proposal", () => {
    const s = new DecisionSession(); s.preview(observation("melee"), now);
    expect(s.preview(observation("menu", now + 1), now + 1).action).toBe("release");
    expect(s.status().pending).toBeUndefined(); expect(s.status().reports[0].status).toBe("cancelled");
  });
  it("changed threat conditions invalidate a pending action before replanning", () => {
    const s = new DecisionSession(); s.preview(observation("melee"), now);
    expect(s.preview(observation("dodge", now + 1), now + 1).action).toBe("release");
    expect(s.preview(observation("dodge", now + 2), now + 2).action).toBe("dodge");
  });
  it("invalid observations cancel a pending action", () => {
    const s = new DecisionSession(); s.preview(observation("follow"), now);
    expect(() => s.preview({}, now + 1)).toThrow(); expect(s.status().pending).toBeUndefined();
  });
  it("does not reuse a failed proposal or old feedback", () => {
    const s = new DecisionSession(), o = observation("melee"), p = s.preview(o, now);
    expect(() => s.feedback(p.id, "completed")).toThrow("模拟");
    s.feedback(p.id, "simulated-failed");
    expect(() => s.feedback(p.id, "simulated-complete")).toThrow("当前");
    expect(s.preview(o, now).action).toBe("release");
    expect(s.preview(observation("melee", now + 1), now + 1).action).toBe("melee");
  });
  it("out-of-order observation cancels pending work", () => {
    const s = new DecisionSession(); s.preview(observation("follow", now), now);
    expect(s.preview(observation("follow", now - 1), now).action).toBe("release");
    expect(s.status().pending).toBeUndefined();
  });
  it("future rejected observation does not poison the next genuine timestamp", () => {
    const s = new DecisionSession(); expect(s.preview(observation("follow", now + 10000), now).action).toBe("release");
    expect(s.preview(observation("follow", now + 1), now + 1).action).toBe("follow");
  });
  it("does not infer potion cooldown from elapsed time or uncertain frames", () => {
    const s = new DecisionSession(); const p = s.preview(observation("heal"), now); s.feedback(p.id, "simulated-complete");
    const uncertain = observation("heal", now + 500); uncertain.confidence = 0.5; uncertain.self.potionReady = false;
    expect(s.preview(uncertain, now + 500).action).toBe("release");
    expect(s.preview(observation("heal", now + 50000), now + 50000).action).toBe("wait");
    const depleted = observation("heal", now + 50001); depleted.self.potionReady = false;
    s.preview(depleted, now + 50001);
    expect(s.preview(observation("heal", now + 50002), now + 50002).action).toBe("heal");
  });
  it("stops until reset and does not expose mutable internal state", () => {
    const s = new DecisionSession(); s.preview(observation("follow"), now);
    const state = s.status(); state.pending!.action = "melee";
    expect(s.status().pending!.action).toBe("follow");
    s.stop(); expect(s.preview(observation("melee", now + 1), now + 1).action).toBe("release");
    s.reset(); expect(s.preview(observation("melee", now + 2), now + 2).action).toBe("melee");
  });
});
it("plugin only registers preview IPC; no game, model or Chat services", async () => {
  const calls = new Map<string, (...args: any[]) => any>(); let dispose: (() => unknown) | undefined;
  const ctx = { signal: new AbortController().signal, registerIpc: (name: string, fn: (...args: any[]) => any) => calls.set(name, fn), onDispose: (fn: () => unknown) => { dispose = fn; } };
  await createPlugin().register!(ctx as any);
  expect([...calls.keys()]).toEqual(["decision-status", "decision-examples", "decision-example", "decision-preview", "decision-feedback", "decision-stop", "decision-reset"]);
  expect(calls.get("decision-status")!().gameInputSent).toBe(false);
  dispose!(); expect(calls.get("decision-status")!().stopped).toBe(true);
});

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: unknown) => { window: Window & { eval(code: string): void; MessageEvent: typeof MessageEvent } };
};
it("panel previews and acknowledges through official bridge without input IPC", async () => {
  const dom = new JSDOM(await readFile("plugins/dungeons-decision/static/settings.html", "utf8"), { runScripts: "outside-only", url: "https://panel.invalid" });
  const s = new DecisionSession(), requests: string[] = [];
  const wait = async (condition: () => boolean) => {
    for (let n = 0; n < 100; n++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error(`Panel condition deadline: ${dom.window.document.querySelector("#notice")!.textContent}; ${requests.join(",")}`);
  };
  dom.window.addEventListener("message", event => {
    const m = event.data; if (m.kind !== "invoke") return; requests.push(m.channel);
    let data;
    if (m.channel === "decision-status") data = s.status();
    else if (m.channel === "decision-examples") data = scenarios;
    else if (m.channel === "decision-example") data = example(m.args[0], Date.now());
    else if (m.channel === "decision-preview") data = s.preview(m.args[0]);
    else if (m.channel === "decision-feedback") data = s.feedback(m.args[0], m.args[1]);
    else if (m.channel === "decision-reset") data = s.reset();
    else if (m.channel === "decision-stop") data = s.stop();
    else throw Error(`Unexpected IPC ${m.channel}`);
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "invoke-result", seq: m.seq, ok: true, data } }));
  });
  dom.window.eval(await readFile("../src/main/plugin-panel/panel-bridge.js", "utf8"));
  dom.window.eval(await readFile("plugins/dungeons-decision/static/settings.js", "utf8"));
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "init", theme: {} } }));
  const button = (id: string) => dom.window.document.querySelector<HTMLButtonElement>(`#${id}`)!;
  try {
    await wait(() => !!dom.window.document.querySelector("#history")!.textContent);
    expect(dom.window.document.querySelector<HTMLSelectElement>("#scenario")!.options).toHaveLength(12);
    dom.window.document.querySelector<HTMLSelectElement>("#scenario")!.value = "heal";
    button("run-example").click(); await wait(() => !button("complete").disabled);
    expect(s.status().pending!.action).toBe("heal"); expect(button("complete").disabled).toBe(false);
    button("complete").click(); await wait(() => button("complete").disabled); expect(s.status().pending).toBeUndefined();
    button("stop").click(); await wait(() => !!dom.window.document.querySelector("#decision")!.textContent?.includes("已停止")); expect(s.status().stopped).toBe(true);
    expect(requests.every(name => name.startsWith("decision-"))).toBe(true);
  } finally { dom.window.close(); }
});
