import { expect, it } from "vitest";
import { createEntityGraph } from "../plugins/companion-memory/src/entity-graph";
function fixture() {
 const data = new Map<string, any>(); let fail = false;
 const storage = { get: (key: string) => structuredClone(data.get(key)), set: (key: string, value: any) => { if (fail) throw Error("disk"); data.set(key, structuredClone(value)); }, rootDir: () => "unused" };
 return { storage, fail: (value: boolean) => { fail = value; } };
}
const turn = { id: "u", sessionId: "c", user: "最爱乌龙茶", assistant: "", userAt: 1, assistantAt: 2 };
it("source reconciliation is idempotent and removes edited/deleted/regenerated facts across restart", () => {
 const f=fixture();let graph=createEntityGraph(f.storage);graph.reconcile([]);
 graph.reconcile([turn]);graph.reconcile([turn]);expect(graph.search("乌龙茶")).not.toContain("提及2次");
 graph=createEntityGraph(f.storage);graph.reconcile([{...turn,user:"最爱红茶"}]);
 expect(graph.search("乌龙茶")).toBe("");expect(graph.search("红茶")).toContain("红茶");
 graph.reconcile([]);expect(createEntityGraph(f.storage).view().count).toBe(0);
});
it("failed persistence leaves cache unchanged and can be retried on restart", () => {
 const f=fixture();const graph=createEntityGraph(f.storage);graph.reconcile([]);f.fail(true);
 expect(()=>graph.reconcile([turn])).toThrow("disk");expect(graph.search("乌龙茶")).toBe("");
 f.fail(false);const restarted=createEntityGraph(f.storage);restarted.reconcile([turn]);expect(restarted.search("乌龙茶")).toContain("乌龙茶");
});
it("untraceable baseline survives while new source contributions can be removed", () => {
 const f=fixture();let graph=createEntityGraph(f.storage);graph.ingest(["最爱乌龙茶"]);
 graph=createEntityGraph(f.storage);graph.reconcile([turn]);expect(graph.search("乌龙茶")).not.toContain("提及2次");
 graph.reconcile([turn,{...turn,id:"new"}]);expect(graph.search("乌龙茶")).toContain("提及2次");
 graph.reconcile([]);expect(graph.search("乌龙茶")).toContain("乌龙茶");expect(graph.search("乌龙茶")).not.toContain("提及2次");
});
