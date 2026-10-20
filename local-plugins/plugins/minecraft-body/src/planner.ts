import type { Point, TaskAction, TaskGoal, TaskSnapshot, PlanDecision } from "./contracts";

/** Normalized from the connected protocol's complete vanilla registry, never recipesFor(). */
export interface Recipe {
  id: string;
  output: { name: string; count: number };
  ingredients: Array<{ name: string; count: number }>;
  requiresTable: boolean;
}
export interface RecipeCatalog {
  supported: boolean; version: string; source: "minecraft-data"; reason?: string; recipes: Recipe[];
}
export interface RecipePlan {
  decision: PlanDecision;
  desiredTotal: number;
  requiredDelta: number;
  steps: Array<{ action: TaskAction; recipeBatches?: number; recipeId?: string }>;
  remainingInventory: Record<string, number>;
}
const ITEMS = new Set(["oak_log", "oak_planks", "stick", "crafting_table", "wooden_pickaxe"]);
const validCount = (n: number) => Number.isSafeInteger(n) && n > 0;
const pointKey = (p: Point) => `${p.x},${p.y},${p.z}`;
const comparePoints = (a: Point, b: Point) => a.x - b.x || a.y - b.y || a.z - b.z;

/** Full bounded dry run reserves inputs immediately and keeps recipe yield leftovers.
 * Only the first action is executable. Every result must be followed by a new observation.
 * A partly expanded plan is NOT a successful plan, including on budget exhaustion.
 */
export function createRecipePlan(snapshot: TaskSnapshot, goal: TaskGoal): RecipePlan {
  const inventory = { ...snapshot.inventory };
  const steps: RecipePlan["steps"] = [];
  const desiredTotal = goal.desiredTotal;
  const requiredDelta = Math.max(0, desiredTotal - (inventory[goal.item] || 0));
  const finish = (decision: PlanDecision): RecipePlan => ({ decision, desiredTotal, requiredDelta, steps, remainingInventory: inventory });
  function fail(reason: string): never { throw new Error(reason); }
  try {
    if (goal.item !== "wooden_pickaxe" || !validCount(desiredTotal)) fail("unsupported_goal");
    if (Object.values(inventory).some((n) => !Number.isSafeInteger(n) || n < 0)) fail("invalid_inventory");
    if (!snapshot.connected) fail("not_connected");
    const region = goal.allowedRegion;
    const finitePoint = (p: Point | undefined): p is Point => !!p && [p.x, p.y, p.z].every(Number.isFinite);
    if (!region || !finitePoint(region.min) || !finitePoint(region.max) ||
        ["x", "y", "z"].some((axis) => region.min[axis as keyof Point] > region.max[axis as keyof Point])) fail("invalid_allowed_region");
    const inside = (p: Point | undefined) => finitePoint(p) && p.x >= region.min.x && p.x <= region.max.x &&
      p.y >= region.min.y && p.y <= region.max.y && p.z >= region.min.z && p.z <= region.max.z;
    if (snapshot.dimension !== region.dimension || !inside(snapshot.position)) fail("outside_allowed_region");
    if (requiredDelta === 0) return finish({ kind: "completed", reason: "observed_inventory_goal_met" });
    if (!validCount(goal.actionBudget)) fail("plan_budget_exhausted");
    const budget = Math.min(goal.actionBudget, 64);
    const catalog = snapshot.recipeCatalog as RecipeCatalog | undefined;
    if (!catalog?.supported || !catalog.version || catalog.version !== snapshot.protocolVersion || catalog.source !== "minecraft-data") fail("unsupported_recipe_version");
    if (!Array.isArray(catalog.recipes)) fail("unsupported_recipe_catalog");
    const observations = snapshot.taskObservation;
    if (!observations) fail("missing_task_observation");
    const reachable = (value: unknown) => (value as { reachable?: boolean; safe?: boolean })?.reachable !== false && (value as { safe?: boolean })?.safe !== false;
    const tables = observations.craftingTables.filter((p) => inside(p) && reachable(p)).sort(comparePoints);
    let table = tables[0];
    const placements = observations.placementCandidates.filter((p) => inside(p) && reachable(p) && [p.x,p.y,p.z].every(Number.isInteger)).sort(comparePoints);
    const logs = observations.logs.filter((r) => r.name === "oak_log" && inside(r.position) && reachable(r)).sort((a,b) => comparePoints(a.position,b.position));
    const usedLogs = new Set<string>();
    const usedDrops = new Set<string>();
    const drops = observations.drops.filter((r) => ITEMS.has(r.name) && inside(r.position) && reachable(r) &&
      (r.count === undefined || validCount(r.count))).sort((a,b) => comparePoints(a.position,b.position));
    const push = (action: TaskAction, recipe?: Recipe, batches?: number) => {
      if (steps.length >= budget) fail("plan_budget_exhausted");
      steps.push({ action, ...(recipe ? { recipeId: recipe.id, recipeBatches: batches } : {}) });
    };
    const stack = new Set<string>();
    const ensure = (name: string, desired: number): void => {
      let delta = desired - (inventory[name] || 0);
      if (delta <= 0) return;
      for (const drop of drops.filter((r) => r.name === name)) {
        const key = `${name}:${pointKey(drop.position)}`;
        if (usedDrops.has(key)) continue;
        push({ action: "pickup", material: name, count: 1, position: { ...drop.position } });
        usedDrops.add(key);
        inventory[name] = (inventory[name] || 0) + (drop.count ?? 1);
        delta = desired - inventory[name];
        if (delta <= 0) return;
      }
      if (!ITEMS.has(name)) fail(`unsupported_ingredient:${name}`);
      if (name === "oak_log") {
        if (!goal.allowCollect) fail("collection_not_authorized:oak_log");
        for (let i = 0; i < delta; i++) {
          const log = logs.find((r) => !usedLogs.has(pointKey(r.position)));
          if (!log) fail("missing_safe_reachable_resource:oak_log");
          usedLogs.add(pointKey(log.position));
          push({ action: "collect", material: "木头", count: 1, position: { ...log.position } });
          inventory.oak_log = (inventory.oak_log || 0) + 1;
        }
        return;
      }
      if (stack.has(name)) fail(`cyclic_recipe:${name}`);
      const recipes = catalog.recipes.filter((r) => r.output?.name === name).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      // Only oak-based recipes are in V1; unsupported alternatives are not guessed.
      const recipe = recipes.find((r) => Array.isArray(r.ingredients) && r.ingredients.length > 0 && r.ingredients.every((i) => ITEMS.has(i.name)));
      if (!recipe || !validCount(recipe.output.count) || !recipe.ingredients.every((i) => validCount(i.count))) fail(`unsupported_recipe:${name}`);
      stack.add(name);
      if (recipe.requiresTable && !table) {
        if (!goal.allowPlace) fail("missing_workbench:placement_not_authorized");
        const target = placements[0];
        if (!target) fail("missing_workbench:no_safe_placement");
        try { ensure("crafting_table", 1); }
        catch (error) { fail(`missing_workbench:needs_materials:${(error as Error).message}`); }
        inventory.crafting_table -= 1;
        push({ action: "place", material: "crafting_table", count: 1, position: { ...target } });
        table = target;
      }
      const batches = Math.ceil(delta / recipe.output.count);
      const inputs = new Map<string,number>();
      for (const input of recipe.ingredients) inputs.set(input.name, (inputs.get(input.name) || 0) + input.count * batches);
      // Reserve each ingredient before expanding the next shared dependency.
      for (const [input, count] of inputs) { ensure(input, count); inventory[input] -= count; }
      push({ action: "craft", material: name, count: delta, ...(recipe.requiresTable ? { position: { ...table! } } : {}) }, recipe, batches);
      inventory[name] = (inventory[name] || 0) + recipe.output.count * batches;
      stack.delete(name);
    };
    ensure(goal.item, desiredTotal);
    if (!steps.length || (inventory[goal.item] || 0) < desiredTotal) fail("incomplete_plan");
    return finish({ kind: "action", action: steps[0].action, reason: "bounded_recipe_plan_reobserve_after_action" });
  } catch (error) {
    return finish({ kind: "blocked", reason: (error as Error).message });
  }
}

/** Inventory completion only: TaskController separately equips and reobserves heldItem. */
export function planNext(snapshot: TaskSnapshot, goal: TaskGoal): PlanDecision {
  return createRecipePlan(snapshot, goal).decision;
}
