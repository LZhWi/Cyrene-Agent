import type { Live2DModel } from "pixi-live2d-display/cubism4";
import type { HoloCubicInputEvent } from "../../shared/holocubic-types";

const ACTIVE_EVENTS = new Set(["start", "long_start", "long_repeat"]);
const RELEASE_EVENTS = new Set(["short", "long_end", "exit"]);

export class TiltFocusController {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly model: Live2DModel,
  ) {}

  focusCenter(instant = false): void {
    const rect = this.canvas.getBoundingClientRect();
    this.model.focus(rect.width / 2, rect.height / 2, instant);
  }

  handleInput(event: HoloCubicInputEvent): void {
    if (event.type !== "key") return;
    if (event.key === "home" || RELEASE_EVENTS.has(event.event)) {
      this.focusCenter();
      return;
    }
    if (!ACTIVE_EVENTS.has(event.event)) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.key === "left" ? 0 : event.key === "right" ? rect.width : rect.width / 2;
    const y = event.key === "up" ? 0 : event.key === "down" ? rect.height : rect.height / 2;
    this.model.focus(x, y);
  }
}
