import { describe, expect, it, vi } from "vitest";
import { InteractionController, type HitAreaDef } from "./interaction";

const sunglasses: HitAreaDef = {
  name: "墨镜刘海", id: "ArtMesh20", group: "表情#2", motionName: "墨镜", motionIndex: -1,
};

function fixture(hitNames: string[] = []) {
  const listeners = new Map<string, (event: PointerEvent) => void>();
  const canvas = {
    addEventListener: vi.fn((name: string, listener: (event: PointerEvent) => void) => listeners.set(name, listener)),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 500 }),
  } as unknown as HTMLCanvasElement;
  const expression = vi.fn(async (name: string) => name === "问号" || hitNames.length > 0);
  const model = {
    expression,
    hitTest: vi.fn(() => hitNames),
    internalModel: { motionManager: { definitions: {} } },
  } as never;
  return { listeners, canvas, model, expression };
}

describe("桌宠交互热区", () => {
  it("精确命中优先于新增身体热区", () => {
    const data = fixture(["墨镜刘海"]);
    const onBodyClick = vi.fn();
    new InteractionController(data.canvas, data.model, [sunglasses], {
      bodyRegion: { left: 0.4, top: 0.6, right: 0.7, bottom: 0.83 }, onBodyClick,
    });
    data.listeners.get("pointerdown")?.({ clientX: 220, clientY: 350 } as PointerEvent);
    data.listeners.get("pointerup")?.({ clientX: 220, clientY: 350 } as PointerEvent);
    expect(onBodyClick).not.toHaveBeenCalled();
    expect(data.expression).toHaveBeenCalledWith("墨镜");
  });

  it("身体热区触发随机动作，并为重复墨镜表情使用问号回退", async () => {
    const data = fixture();
    const onBodyClick = vi.fn();
    const controller = new InteractionController(data.canvas, data.model, [sunglasses], {
      bodyRegion: { left: 0.4, top: 0.6, right: 0.7, bottom: 0.83 },
      onBodyClick,
      repeatExpressionFallbacks: { "墨镜": "问号" },
    });
    data.listeners.get("pointerdown")?.({ clientX: 220, clientY: 350 } as PointerEvent);
    data.listeners.get("pointerup")?.({ clientX: 220, clientY: 350 } as PointerEvent);
    expect(onBodyClick).toHaveBeenCalledOnce();
    await expect((controller as unknown as { tryPlay: (area: HitAreaDef) => Promise<boolean> }).tryPlay(sunglasses)).resolves.toBe(true);
    expect(data.expression.mock.calls).toEqual([["墨镜"], ["问号"]]);
  });
});
