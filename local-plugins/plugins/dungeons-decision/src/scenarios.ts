import type { Action, Observation } from "./policy";

export const scenarios: { id: string; name: string; expected: Action; patch: Partial<Observation> }[] = [
  { id: "idle", name: "队友身边待命", expected: "wait", patch: {} },
  { id: "follow", name: "沿安全路径跟随", expected: "follow", patch: { leader: { position: { x: 0.8, y: 0.5 }, downed: false, reviveAvailable: false } } },
  { id: "blocked", name: "跟随路径不明", expected: "wait", patch: { leader: { position: { x: 0.8, y: 0.5 }, downed: false, reviveAvailable: false }, paths: { leader: null, escape: true } } },
  { id: "melee", name: "协助近战", expected: "melee", patch: { enemy: { position: { x: 0.55, y: 0.5 }, threatens: true, meleeReach: true, clearShot: false } } },
  { id: "ranged", name: "有箭且射线已确认", expected: "ranged", patch: { enemy: { position: { x: 0.7, y: 0.5 }, threatens: false, meleeReach: false, clearShot: true } } },
  { id: "heal", name: "低血量优先治疗", expected: "heal", patch: { self: { position: { x: 0.5, y: 0.5 }, health: 0.2, downed: false, potionReady: true, dodgeReady: true } } },
  { id: "retreat", name: "低血无药沿退路撤离", expected: "retreat", patch: { self: { position: { x: 0.5, y: 0.5 }, health: 0.2, downed: false, potionReady: false, dodgeReady: true }, enemy: { position: { x: 0.55, y: 0.5 }, threatens: true, meleeReach: true, clearShot: false } } },
  { id: "dodge", name: "迫近危险优先闪避", expected: "dodge", patch: { imminentDanger: true } },
  { id: "revive", name: "确认提示后安全救援", expected: "revive", patch: { leader: { position: { x: 0.55, y: 0.5 }, downed: true, reviveAvailable: true } } },
  { id: "downed", name: "自身倒地等待救援", expected: "release", patch: { self: { position: { x: 0.5, y: 0.5 }, health: 0, downed: true, potionReady: true, dodgeReady: true } } },
  { id: "uncertain", name: "识别不可靠时停止", expected: "release", patch: { confidence: 0.5 } },
  { id: "menu", name: "菜单中不操作", expected: "release", patch: { scene: "menu" } },
];
export function example(id: string, now: number): Observation {
  const scenario = scenarios.find(s => s.id === id); if (!scenario) throw Error("未知预演场景");
  return structuredClone({
    id: `simulation-${id}-${now}`, capturedAt: now, source: "simulation", scene: "playing", foreground: true, confidence: 0.95,
    self: { position: { x: 0.5, y: 0.5 }, health: 0.9, downed: false, potionReady: true, dodgeReady: true },
    leader: { position: { x: 0.55, y: 0.5 }, downed: false, reviveAvailable: false }, enemy: null,
    arrows: 20, imminentDanger: false, escape: { x: 0.4, y: 0.5 }, paths: { leader: true, escape: true }, ...scenario.patch,
  } as Observation);
}
