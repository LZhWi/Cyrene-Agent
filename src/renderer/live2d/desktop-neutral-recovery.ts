import type { Live2DModel } from "pixi-live2d-display/cubism4";

interface ParameterModel {
  getParameterCount(): number;
  getParameterValueByIndex(index: number): number;
  setParameterValueByIndex(index: number, value: number): void;
}

interface DesktopModelEvents {
  on(event: "afterMotionUpdate", listener: () => void): void;
  off(event: "afterMotionUpdate", listener: () => void): void;
  coreModel: ParameterModel;
  motionManager: {
    on(event: "motionStart", listener: (group: string, index: number) => void): void;
    off(event: "motionStart", listener: (group: string, index: number) => void): void;
  };
}

/** Smoothly commits the desktop renderer's parameters back to its startup baseline. */
export class DesktopNeutralRecoveryController {
  private readonly internalModel: DesktopModelEvents;
  private readonly neutralValues: number[];
  private readonly durationMs: number;
  private readonly resetMotionGroup: string;
  private readonly resetMotionIndex: number;
  private startValues: number[] = [];
  private startedAt = 0;
  private active = false;

  constructor(
    model: Live2DModel,
    durationMs = 800,
    resetMotionGroup = "动作#6",
    resetMotionIndex = 0,
  ) {
    this.internalModel = model.internalModel as unknown as DesktopModelEvents;
    this.durationMs = Math.max(1, durationMs);
    this.resetMotionGroup = resetMotionGroup;
    this.resetMotionIndex = resetMotionIndex;
    this.neutralValues = this.readParameters();
    this.internalModel.on("afterMotionUpdate", this.update);
    this.internalModel.motionManager.on("motionStart", this.handleMotionStart);
  }

  start(): void {
    this.startValues = this.readParameters();
    this.startedAt = performance.now();
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  dispose(): void {
    this.cancel();
    this.internalModel.off("afterMotionUpdate", this.update);
    this.internalModel.motionManager.off("motionStart", this.handleMotionStart);
  }

  private readonly handleMotionStart = (group: string, index: number): void => {
    if (group !== this.resetMotionGroup || index !== this.resetMotionIndex) this.cancel();
  };

  private readonly update = (): void => {
    if (!this.active) return;
    const progress = Math.min(1, Math.max(0, (performance.now() - this.startedAt) / this.durationMs));
    const weight = progress * progress * (3 - 2 * progress);
    const count = Math.min(this.startValues.length, this.neutralValues.length);
    for (let index = 0; index < count; index += 1) {
      const start = this.startValues[index];
      const neutral = this.neutralValues[index];
      this.internalModel.coreModel.setParameterValueByIndex(index, start + (neutral - start) * weight);
    }
    if (progress >= 1) this.cancel();
  };

  private readParameters(): number[] {
    const count = this.internalModel.coreModel.getParameterCount();
    return Array.from({ length: count }, (_, index) => (
      this.internalModel.coreModel.getParameterValueByIndex(index)
    ));
  }
}
