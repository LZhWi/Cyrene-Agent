import { describe, expect, it } from "vitest";
import { createRecipePlan, planNext, type RecipeCatalog } from "./planner";
import type { TaskGoal, TaskSnapshot } from "./contracts";

const p = (x: number) => ({ x, y: 64, z: 0 });
const goal: TaskGoal = { item: "wooden_pickaxe", desiredTotal: 1, equip: true, allowCollect: true, allowPlace: true,
  allowedRegion: { dimension: "overworld", min: { x: -10, y: 60, z: -10 }, max: { x: 10, y: 70, z: 10 } }, timeoutMs: 60000, actionBudget: 32 };
const recipeCatalog: RecipeCatalog = { supported: true, version: "1.21.11", source: "minecraft-data", recipes: [
  { id: "planks", output: { name: "oak_planks", count: 4 }, ingredients: [{ name: "oak_log", count: 1 }], requiresTable: false },
  { id: "sticks", output: { name: "stick", count: 4 }, ingredients: [{ name: "oak_planks", count: 2 }], requiresTable: false },
  { id: "table", output: { name: "crafting_table", count: 1 }, ingredients: [{ name: "oak_planks", count: 4 }], requiresTable: false },
  { id: "pickaxe", output: { name: "wooden_pickaxe", count: 1 }, ingredients: [{ name: "oak_planks", count: 3 }, { name: "stick", count: 2 }], requiresTable: true },
] };
function snap(inventory: Record<string, number> = {}): TaskSnapshot {
  return { connected: true, position: p(0), dimension: "overworld", inventory, protocolVersion: "1.21.11", recipeCatalog,
    taskObservation: { logs: [1,2,3].map((x) => ({ name: "oak_log", position: p(x) })), drops: [], craftingTables: [], placementCandidates: [p(4)] } };
}
describe("pure wooden pickaxe planner", () => {
  it("plans empty inventory without double counting shared table and pickaxe planks", () => {
    const s = snap(); const before = JSON.stringify(s); const plan = createRecipePlan(s, goal);
    expect(plan.decision.kind).toBe("action");
    expect(plan.steps.filter((s) => s.action.action === "collect")).toHaveLength(3);
    expect(plan.remainingInventory).toMatchObject({ wooden_pickaxe: 1, oak_planks: 3, stick: 2, crafting_table: 0 });
    expect(JSON.stringify(s)).toBe(before); expect(createRecipePlan(s, goal)).toEqual(plan);
  });
  it("distinguishes desired total, required delta and yield batches with partial planks", () => {
    const plan = createRecipePlan(snap({ oak_planks: 2, oak_log: 2 }), goal);
    expect(plan.decision.kind).toBe("action");
    const planks = plan.steps.find((s) => s.action.material === "oak_planks")!;
    expect(planks.action.count).toBe(2); expect(planks.recipeBatches).toBe(1);
    expect(plan.desiredTotal).toBe(1); expect(plan.requiredDelta).toBe(1);
    expect(plan.remainingInventory.wooden_pickaxe).toBe(1);
  });
  it("replans from changed live inventory instead of replaying an old action", () => {
    expect(planNext(snap(), goal).kind).toBe("action");
    const current = snap({ oak_planks: 3, stick: 2 }); current.taskObservation!.craftingTables = [p(1)];
    expect(planNext(current, goal)).toMatchObject({ kind: "action", action: { action: "craft", material: "wooden_pickaxe", count: 1 } });
    expect(planNext(snap({ wooden_pickaxe: 1 }), goal).kind).toBe("completed");
  });
  it("does not confuse other wood variants with oak inputs", () => {
    const current = snap({ birch_planks: 64 }); current.taskObservation!.logs = [];
    expect(planNext(current, goal).kind).toBe("blocked");
  });
  it("preserves partial sticks and crafts only the missing output delta", () => {
    const current = snap({ oak_planks: 5, stick: 1 }); current.taskObservation!.craftingTables = [p(1)];
    const plan = createRecipePlan(current, goal);
    expect(plan.decision).toMatchObject({ kind: "action", action: { action: "craft", material: "stick", count: 1 } });
    expect(plan.steps[0].recipeBatches).toBe(1);
    expect(plan.remainingInventory.stick).toBe(3);
  });
  it("uses existing inventory table without charging table recipe inputs", () => {
    const plan = createRecipePlan(snap({ crafting_table: 1, oak_planks: 5 }), goal);
    expect(plan.decision).toMatchObject({ kind: "action", action: { action: "place" } });
    expect(plan.remainingInventory.oak_planks).toBe(0);
    expect(plan.steps.some((s) => s.action.action === "collect")).toBe(false);
  });
  it("blocks unknown or mismatched protocol and missing recipe", () => {
    expect(planNext({ ...snap(), protocolVersion: "1.20" }, goal)).toMatchObject({ kind: "blocked", reason: "unsupported_recipe_version" });
    expect(planNext({ ...snap(), recipeCatalog: { ...recipeCatalog, supported: false } }, goal).kind).toBe("blocked");
    expect(planNext({ ...snap(), recipeCatalog: { ...recipeCatalog, recipes: [] } }, goal)).toMatchObject({ kind: "blocked", reason: "unsupported_recipe:wooden_pickaxe" });
  });
  it("does not target out-of-area or explicitly unreachable resources", () => {
    const current = snap(); current.taskObservation!.logs = [{ name: "oak_log", position: p(20) }, { name: "oak_log", position: p(1), reachable: false } as any];
    expect(planNext(current, goal)).toMatchObject({ kind: "blocked" });
  });
  it("explains blocked workbench placement and missing materials", () => {
    const current = snap(); current.taskObservation!.placementCandidates = [];
    expect(planNext(current, goal)).toMatchObject({ kind: "blocked", reason: "missing_workbench:no_safe_placement" });
    current.taskObservation!.placementCandidates = [p(4)]; current.taskObservation!.logs = [];
    expect(planNext(current, goal)).toMatchObject({ kind: "blocked", reason: "missing_workbench:needs_materials:missing_safe_reachable_resource:oak_log" });
  });
  it("never reports successful partial plans on plan budget exhaustion", () => {
    expect(planNext(snap(), { ...goal, actionBudget: 1 })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("plan_budget_exhausted") });
    expect(planNext(snap(), { ...goal, actionBudget: 0 })).toMatchObject({ kind: "blocked", reason: "plan_budget_exhausted" });
  });
  it("uses observed named drops before collecting or crafting", () => {
    const current = snap(); current.taskObservation!.logs = [];
    current.taskObservation!.drops = [{ name: "oak_log", count: 3, position: p(1) }];
    const plan = createRecipePlan(current, goal);
    expect(plan.decision).toMatchObject({ kind: "action", action: { action: "pickup", material: "oak_log", count: 1 } });
    expect(plan.remainingInventory.wooden_pickaxe).toBe(1);
    expect(plan.steps.filter((s) => s.action.action === "pickup")).toHaveLength(1);
  });
  it("rejects unsafe state and never borrows outside the allowed dimension", () => {
    expect(planNext({ ...snap(), dimension: "the_nether" }, goal).kind).toBe("blocked");
    expect(planNext(snap({ oak_planks: -1 }), goal).kind).toBe("blocked");
    expect(planNext(snap(), { ...goal, allowPlace: false }).kind).toBe("blocked");
    expect(planNext(snap(), { ...goal, allowCollect: false }).kind).toBe("blocked");
  });
});
