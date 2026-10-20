/** V1 deliberately supports one verifiable inventory goal, not arbitrary programs. */
export interface Point { x: number; y: number; z: number }
export interface AllowedRegion { dimension: string; min: Point; max: Point; allowCollect?: boolean; allowPlace?: boolean }
export interface TaskGoal {
  item: "wooden_pickaxe"; desiredTotal: 1; equip: boolean;
  allowedRegion: AllowedRegion; allowCollect: boolean; allowPlace: boolean;
  timeoutMs: number; actionBudget: number;
}
export interface TaskSnapshot {
  connected: boolean; position?: Point; dimension?: string; inventory: Record<string, number>;
  heldItem?: string | null; health?: number; activeAction?: { id: string; draining?: boolean } | null;
  sampledAt?: string;
  protocolVersion?: string;
  recipeCatalog?: { supported: boolean; version: string; source: "minecraft-data"; reason?: string; recipes: Array<{ id: string; output: {name: string; count: number}; ingredients: Array<{name:string;count:number}>; requiresTable: boolean }> };
  taskObservation?: {
    logs: Array<{ name: string; position: Point }>;
    drops: Array<{ name: string; position: Point; count?: number }>;
    craftingTables: Point[];
    placementCandidates: Point[];
  };
  [key: string]: unknown;
}
export interface TaskAction { action: "collect" | "pickup" | "craft" | "place" | "equip"; material?: string; count?: number; position?: Point; timeoutMs?: number }
export type PlanDecision = { kind: "action"; action: TaskAction; reason: string } | { kind: "completed"; reason: string } | { kind: "blocked"; reason: string };
export interface ActionResult { id: string; action: string; status: string; effectsUncertain?: boolean; reason?: string; before?: TaskSnapshot; after?: TaskSnapshot; [key: string]: unknown }
export interface TaskBody {
  acquireTask(taskId: string, region: AllowedRegion): Promise<void> | void;
  releaseTask(taskId: string): Promise<void> | void;
  observeTask(taskId: string, region: AllowedRegion): Promise<TaskSnapshot>;
  taskAction(taskId: string, action: TaskAction, region: AllowedRegion): Promise<ActionResult>;
  cancel(): unknown;
  assertQuiescent?(region: AllowedRegion): Promise<void>;
}
export type TaskState = "running" | "completed" | "blocked" | "cancelled" | "interrupted";
export interface TaskRecord {
  id: string; goal: TaskGoal; state: TaskState; reason: string; startedAt: string; updatedAt: string;
  actions: number; effectsUncertain: boolean; lastSnapshot?: TaskSnapshot; lastAction?: ActionResult;
  outcomeBasis?: "observed_inventory_and_equipment"; skillLearned: false;
}
