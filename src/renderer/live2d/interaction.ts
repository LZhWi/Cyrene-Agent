import type { Live2DModel } from "pixi-live2d-display/cubism4";

/**
 * Resolved description of a single hit area and the motion/expression it triggers.
 *
 * The model's HitAreas use a "group:motionName" trigger string. Some entries
 * point at real motion files, while others are expression-only pseudo motions,
 * so both paths are resolved here.
 */
export interface HitAreaDef {
  name: string;
  id: string;
  group: string;
  motionName: string;
  motionIndex: number;
  expressionName?: string;
}

export interface InteractionOptions {
  /**
   * Max pointer travel (in CSS pixels) between pointerdown and pointerup
   * for the gesture to still count as a click.
   */
  clickThreshold?: number;
  onBeforeTrigger?: () => void;
  onTrigger?: (area: HitAreaDef) => void;
  onMiss?: (area: HitAreaDef) => void;
  repeatExpressionFallbacks?: Readonly<Record<string, string>>;
  bodyRegion?: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  onBodyClick?: () => void;
}

/**
 * Maps pointer clicks on the Live2D canvas to model hit-area actions.
 */
export class InteractionController {
  private readonly canvas: HTMLCanvasElement;
  private readonly model: Live2DModel;
  private readonly hitAreaByName: Map<string, HitAreaDef>;
  private readonly clickThreshold: number;
  private readonly onBeforeTrigger?: () => void;
  private readonly onTrigger?: (area: HitAreaDef) => void;
  private readonly onMiss?: (area: HitAreaDef) => void;
  private readonly repeatExpressionFallbacks: Readonly<Record<string, string>>;
  private readonly bodyRegion?: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  private readonly onBodyClick?: () => void;

  private downX = 0;
  private downY = 0;
  private downHits: HitAreaDef[] = [];
  private downBodyHit = false;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    model: Live2DModel,
    hitAreaDefs: HitAreaDef[],
    options: InteractionOptions = {},
  ) {
    this.canvas = canvas;
    this.model = model;
    this.clickThreshold = options.clickThreshold ?? 5;
    this.onBeforeTrigger = options.onBeforeTrigger;
    this.onTrigger = options.onTrigger;
    this.onMiss = options.onMiss;
    this.repeatExpressionFallbacks = options.repeatExpressionFallbacks ?? {};
    this.bodyRegion = options.bodyRegion;
    this.onBodyClick = options.onBodyClick;
    this.hitAreaByName = new Map(hitAreaDefs.map((a) => [a.name, a]));

    canvas.addEventListener("pointerdown", this.handleDown);
    canvas.addEventListener("pointerup", this.handleUp);
    canvas.addEventListener("pointercancel", this.handleCancel);
  }

  private handleDown = (e: PointerEvent): void => {
    if (this.disposed) return;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downHits = this.resolveHits(e.clientX, e.clientY);
    this.downBodyHit = this.downHits.length === 0 && this.isBodyHit(e.clientX, e.clientY);
  };

  private handleUp = (e: PointerEvent): void => {
    if (this.disposed) return;
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    const dist = Math.hypot(dx, dy);
    const hits = this.downHits;
    const bodyHit = this.downBodyHit;
    this.downHits = [];
    this.downBodyHit = false;
    if (dist > this.clickThreshold) return;
    if (hits.length === 0 && bodyHit) {
      this.onBodyClick?.();
      return;
    }
    void this.fire(hits);
  };

  private handleCancel = (): void => {
    this.downHits = [];
    this.downBodyHit = false;
  };

  private isBodyHit(x: number, y: number): boolean {
    if (!this.bodyRegion) return false;
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    const nx = (x - bounds.left) / bounds.width;
    const ny = (y - bounds.top) / bounds.height;
    return nx >= this.bodyRegion.left && nx <= this.bodyRegion.right
      && ny >= this.bodyRegion.top && ny <= this.bodyRegion.bottom;
  }

  private resolveHits(x: number, y: number): HitAreaDef[] {
    const names = this.model.hitTest(x, y);
    if (!names || names.length === 0) return [];
    const defs: HitAreaDef[] = [];
    for (const name of names) {
      const def = this.hitAreaByName.get(name);
      if (def) defs.push(def);
    }
    return defs;
  }

  private async fire(hits: HitAreaDef[]): Promise<void> {
    if (hits.length === 0) return;
    this.onBeforeTrigger?.();

    for (let i = 0; i < hits.length; i++) {
      const def = hits[i];
      if (await this.tryPlay(def)) {
        this.onTrigger?.(def);
        return;
      }
      if (i === 0) this.onMiss?.(def);
    }
  }

  private async tryPlay(def: HitAreaDef): Promise<boolean> {
    const defs = this.model.internalModel.motionManager.definitions[def.group];
    if (def.motionIndex >= 0 && defs && def.motionIndex < defs.length) {
      try {
        if (await this.model.motion(def.group, def.motionIndex)) return true;
      } catch (err) {
        console.warn("[Cyrene] motion failed", def.group, def.motionName, err);
      }
    }

    const expressionName = def.expressionName ?? def.motionName;
    try {
      if (await this.model.expression(expressionName)) return true;
      const fallback = this.repeatExpressionFallbacks[expressionName];
      return fallback ? await this.model.expression(fallback) : false;
    } catch (err) {
      console.warn("[Cyrene] expression failed", expressionName, err);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.handleDown);
    this.canvas.removeEventListener("pointerup", this.handleUp);
    this.canvas.removeEventListener("pointercancel", this.handleCancel);
  }
}
