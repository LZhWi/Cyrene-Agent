import { describe, expect, it, vi } from "vitest";
import { InteractionController, type HitAreaDef } from "./interaction";

function createController(expression: ReturnType<typeof vi.fn>): InteractionController {
  const canvas = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 400, height: 500 })),
  } as unknown as HTMLCanvasElement;
  const model = {
    expression,
    hitTest: vi.fn(() => []),
    internalModel: { motionManager: { definitions: {} } },
  } as never;
  return new InteractionController(canvas, model, [], {
    repeatExpressionFallbacks: { "墨镜": "问号" },
  });
}

const sunglassesArea: HitAreaDef = {
  name: "墨镜刘海",
  id: "ArtMesh20",
  group: "表情#2",
  motionName: "墨镜",
  motionIndex: -1,
};

describe("InteractionController expression fallback", () => {
  it("plays question mark when repeated sunglasses is already active", async () => {
    const expression = vi.fn(async (name: string) => name === "问号");
    const controller = createController(expression);

    const played = await (controller as unknown as {
      tryPlay: (def: HitAreaDef) => Promise<boolean>;
    }).tryPlay(sunglassesArea);

    expect(played).toBe(true);
    expect(expression.mock.calls).toEqual([["墨镜"], ["问号"]]);
  });

  it("does not advance when sunglasses starts normally", async () => {
    const expression = vi.fn(async () => true);
    const controller = createController(expression);

    await (controller as unknown as {
      tryPlay: (def: HitAreaDef) => Promise<boolean>;
    }).tryPlay(sunglassesArea);

    expect(expression).toHaveBeenCalledOnce();
    expect(expression).toHaveBeenCalledWith("墨镜");
  });
});

describe("InteractionController body region", () => {
  it("triggers the body action inside the configured central region", () => {
    const listeners = new Map<string, (event: PointerEvent) => void>();
    const canvas = {
      addEventListener: vi.fn((name: string, listener: (event: PointerEvent) => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
      getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 400, height: 500 })),
    } as unknown as HTMLCanvasElement;
    const onBodyClick = vi.fn();
    const model = {
      expression: vi.fn(),
      hitTest: vi.fn(() => []),
      internalModel: { motionManager: { definitions: {} } },
    } as never;
    new InteractionController(canvas, model, [], {
      bodyRegion: { left: 0.4, top: 0.6, right: 0.7, bottom: 0.83 },
      onBodyClick,
    });

    listeners.get("pointerdown")?.({ clientX: 220, clientY: 350 } as PointerEvent);
    listeners.get("pointerup")?.({ clientX: 220, clientY: 350 } as PointerEvent);

    expect(onBodyClick).toHaveBeenCalledOnce();
  });

  it("keeps precise model hit areas ahead of the body fallback", () => {
    const listeners = new Map<string, (event: PointerEvent) => void>();
    const canvas = {
      addEventListener: vi.fn((name: string, listener: (event: PointerEvent) => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
      getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 400, height: 500 })),
    } as unknown as HTMLCanvasElement;
    const onBodyClick = vi.fn();
    const expression = vi.fn(async () => true);
    const model = {
      expression,
      hitTest: vi.fn(() => ["墨镜刘海"]),
      internalModel: { motionManager: { definitions: {} } },
    } as never;
    new InteractionController(canvas, model, [sunglassesArea], {
      bodyRegion: { left: 0.4, top: 0.6, right: 0.7, bottom: 0.83 },
      onBodyClick,
    });

    listeners.get("pointerdown")?.({ clientX: 220, clientY: 350 } as PointerEvent);
    listeners.get("pointerup")?.({ clientX: 220, clientY: 350 } as PointerEvent);

    expect(onBodyClick).not.toHaveBeenCalled();
    expect(expression).toHaveBeenCalledWith("墨镜");
  });

  it("interrupts neutral recovery before attempting a model hit action", async () => {
    const onBeforeTrigger = vi.fn();
    const expression = vi.fn(async () => true);
    const controller = createController(expression);
    (controller as unknown as { onBeforeTrigger?: () => void }).onBeforeTrigger = onBeforeTrigger;

    await (controller as unknown as { fire: (hits: HitAreaDef[]) => Promise<void> }).fire([sunglassesArea]);

    expect(onBeforeTrigger).toHaveBeenCalledOnce();
    expect(onBeforeTrigger.mock.invocationCallOrder[0]).toBeLessThan(expression.mock.invocationCallOrder[0]);
  });
});
