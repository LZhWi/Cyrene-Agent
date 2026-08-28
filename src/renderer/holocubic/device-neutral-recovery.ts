import type { Live2DModel } from "pixi-live2d-display/cubism4";

interface ParameterModel {
  getParameterCount(): number;
  getParameterValueByIndex(index: number): number;
  setParameterValueByIndex(index: number, value: number): void;
}

interface MotionEvents {
  on(event: "afterMotionUpdate", listener: () => void): void;
  off(event: "afterMotionUpdate", listener: () => void): void;
  coreModel: ParameterModel;
}

/** Smoothly commits the device renderer's parameters back to its startup baseline. */
export class DeviceNeutralRecoveryController {
  private readonly internalModel: MotionEvents;
  private readonly neutralValues: number[];
  private readonly durationMs: number;
  private startValues: number[] = [];
  private startedAt = 0;
  private active = false;

  constructor(model: Live2DModel, durationMs = 1_500) {
    this.internalModel = model.internalModel as unknown as MotionEvents;
    this.durationMs = Math.max(1, durationMs);
    this.neutralValues = this.readParameters();
    this.internalModel.on("afterMotionUpdate", this.update);
  }

  start(): void {
    this.startValues = this.readParameters();
    this.startedAt = performance.now();
    this.active = true;
  }

  dispose(): void {
    this.active = false;
    this.internalModel.off("afterMotionUpdate", this.update);
  }

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
    if (progress >= 1) this.active = false;
  };

  private readParameters(): number[] {
    const count = this.internalModel.coreModel.getParameterCount();
    return Array.from({ length: count }, (_, index) => (
      this.internalModel.coreModel.getParameterValueByIndex(index)
    ));
  }
}
