export type Point = { x: number; y: number };
export type Observation = {
  id: string; capturedAt: number; source: "simulation" | "manual";
  scene: "playing" | "menu" | "loading" | "unknown"; foreground: boolean; confidence: number;
  self: { position: Point | null; health: number | null; downed: boolean | null; potionReady: boolean | null; dodgeReady: boolean | null };
  leader: { position: Point | null; downed: boolean | null; reviveAvailable: boolean | null };
  enemy: { position: Point; threatens: boolean | null; meleeReach: boolean | null; clearShot: boolean | null } | null;
  arrows: number | null; imminentDanger: boolean | null; escape: Point | null;
  paths: { leader: boolean | null; escape: boolean | null };
};
export type Action = "release" | "wait" | "follow" | "melee" | "ranged" | "heal" | "dodge" | "retreat" | "revive";
export type Decision = { action: Action; reason: string; durationMs: number; target?: Point };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("观察字段必须是对象");
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw Error("观察数字超出范围");
  return value;
}
function flag(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw Error("未知状态请填写 null，已知状态填写 true/false");
}
function point(value: unknown): Point | null {
  if (value === null) return null;
  const p = record(value); return { x: number(p.x, 0, 1), y: number(p.y, 0, 1) };
}
export function parseObservation(value: unknown): Observation {
  const o = record(value), self = record(o.self), leader = record(o.leader), paths = record(o.paths);
  if (typeof o.id !== "string" || !o.id.trim() || o.id.length > 80) throw Error("观察 ID 无效");
  if (o.source !== "simulation" && o.source !== "manual") throw Error("此版仅接受模拟或手工观察");
  if (!["playing", "menu", "loading", "unknown"].includes(String(o.scene))) throw Error("场景无效");
  if (typeof o.foreground !== "boolean") throw Error("前台状态无效");
  let enemy: Observation["enemy"] = null;
  if (o.enemy !== null) {
    const e = record(o.enemy), position = point(e.position);
    if (!position) throw Error("敌人位置未知时不能指定敌人目标");
    enemy = { position, threatens: flag(e.threatens), meleeReach: flag(e.meleeReach), clearShot: flag(e.clearShot) };
  }
  const arrows = o.arrows === null ? null : number(o.arrows, 0, 100000);
  if (arrows !== null && !Number.isInteger(arrows)) throw Error("箭数必须是整数");
  return {
    id: o.id, capturedAt: number(o.capturedAt, 0, Number.MAX_SAFE_INTEGER), source: o.source,
    scene: o.scene as Observation["scene"], foreground: o.foreground, confidence: number(o.confidence, 0, 1),
    self: { position: point(self.position), health: self.health === null ? null : number(self.health, 0, 1), downed: flag(self.downed), potionReady: flag(self.potionReady), dodgeReady: flag(self.dodgeReady) },
    leader: { position: point(leader.position), downed: flag(leader.downed), reviveAvailable: flag(leader.reviveAvailable) },
    enemy, arrows, imminentDanger: flag(o.imminentDanger), escape: point(o.escape),
    paths: { leader: flag(paths.leader), escape: flag(paths.escape) },
  };
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const choice = (action: Action, reason: string, target?: Point): Decision => ({ action, reason, durationMs: action === "release" || action === "wait" ? 0 : action === "revive" ? 400 : 200, ...(target ? { target } : {}) });

// Screen-space distances are preview heuristics, not world units or stick axes.
// Reachability/readiness must be observed; no assumed cooldown or blind pathing.
export function decide(o: Observation, now: number): Decision {
  if (!Number.isFinite(now) || o.capturedAt > now || now - o.capturedAt > 1500) return choice("release", "观察已过期或时间异常，释放并等待新观察");
  if (!o.foreground || o.scene !== "playing") return choice("release", "游戏失焦或处于菜单/加载，停止动作");
  if (o.confidence < 0.85) return choice("release", "观察可信度不足，重新确认画面");
  if (!o.self.position || o.self.health === null || o.self.downed === null || o.leader.downed === null || o.imminentDanger === null) return choice("release", "自身、队友或危险状态不明，不能行动");
  if (o.self.downed || o.self.health === 0) return choice("release", "昔涟已倒地，等待队友救援，不自行操作复活菜单");
  if (o.enemy && o.enemy.threatens === null) return choice("release", "敌人威胁状态未知，先确认");
  if (o.imminentDanger) {
    if (o.escape && o.paths.escape === true && o.self.dodgeReady === true) return choice("dodge", "危险即将命中，向确认安全的落点闪避", o.escape);
    if (o.escape && o.paths.escape === true) return choice("retreat", "危险临近且无法确认闪避可用，短移至安全位置", o.escape);
    return choice("release", "危险临近但没有确认安全的退路，不盲目翻滚");
  }
  if (o.self.health <= 0.3) {
    if (o.self.potionReady === true) return choice("heal", "生命值偏低且药水可用，优先治疗");
    if (o.enemy && o.escape && o.paths.escape === true) return choice("retreat", "生命值偏低且药水不可用，沿确认退路脱离战斗", o.escape);
    return choice("wait", "生命值偏低，等待药水状态或安全退路，不继续进攻");
  }
  if (!o.leader.position) return choice("release", "看不到绑定队友，停止追踪，不凭旧位置寻找");
  const separation = distance(o.self.position, o.leader.position);
  if (o.leader.downed) {
    if (o.enemy || o.self.health < 0.6) return choice("wait", "救援区域仍有敌人或自身状态不足，暂不救援");
    if (separation <= 0.1 && o.leader.reviveAvailable === true) return choice("revive", "队友倒地且救援提示已确认，短时救援后重新观察", o.leader.position);
    if (separation > 0.1 && o.paths.leader === true) return choice("follow", "沿确认路径接近倒地队友，暂不按救援按钮", o.leader.position);
    return choice("wait", "救援提示或接近路径不明，等待确认");
  }
  if (separation > 0.28) {
    if (o.enemy?.threatens === true && o.enemy.meleeReach === true) return choice("melee", "落后于队友但近身敌人正在威胁，先短时自卫", o.enemy.position);
    return o.paths.leader === true ? choice("follow", "与队友距离过远，优先归队，不追逐远敌", o.leader.position) : choice("wait", "归队路径未确认，不跨越未知地形");
  }
  if (o.enemy) {
    if (o.enemy.meleeReach === true) return choice("melee", "已确认近战可及目标，短时协助战斗", o.enemy.position);
    if (o.enemy.clearShot === true && o.arrows !== null && o.arrows > 0) return choice("ranged", "目标可射击且有箭，短时远程协助", o.enemy.position);
    return choice("wait", "敌人不在已确认近战范围或射线/箭数不明，不盲目攻击或追击");
  }
  if (separation > 0.12) return o.paths.leader === true ? choice("follow", "保持陪伴距离，沿确认路径跟随", o.leader.position) : choice("wait", "跟随路径未确认，等待队友或新观察");
  return choice("wait", "已在队友附近，保持空闲");
}
