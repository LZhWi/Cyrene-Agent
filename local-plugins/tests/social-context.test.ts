import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Turn } from "../plugins/companion-chat/src/chat";
import { createSocialContext } from "../plugins/companion-memory/src/social-context";

function fixture(start = Date.parse("2026-09-20T08:00:00Z")) {
  const data = new Map<string, unknown>();
  const storage: PluginStorage = {
    get: (key) => structuredClone(data.get(key)) as never,
    set: (key, value) => { data.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
  let at = start;
  const generate = vi.fn<(_: string, __: AbortSignal) => Promise<string>>().mockResolvedValue("[]");
  const social = createSocialContext(storage, generate, undefined, () => at);
  const turn = (id: string, user: string, sessionId = "chat-1"): Turn => ({
    id, sessionId, user, assistant: "好的，我们之后继续。", userAt: at - 1_000, assistantAt: at,
  });
  return { social, generate, data, turn, setNow: (value: number) => { at = value; } };
}

const signal = () => new AbortController().signal;

describe("短期状态与未完话题", () => {
  function recoveryFixture(embed: (text: string, signal: AbortSignal) => Promise<number[]>, storedVector?: number[]) {
    const at = Date.parse("2026-10-13T04:00:00Z");
    const state = {version:1,atoms:[{id:"missing",conversationId:"chat-1",type:"short_term",content:"明天去公园",evidenceQuote:"明天去公园",
      evidenceTurnId:"source",createdAt:at,updatedAt:at,expiresAt:at+86400000,status:"active",...(storedVector?{vector:storedVector}:{})}]};
    const set = vi.fn();
    const social = createSocialContext({get:()=>state as never,set,rootDir:()=>"unused"},async()=>{throw Error("No generation");},embed,()=>at);
    return {social,state,set};
  }

  it("旧事项全缺向量时恢复并缓存，不修改证据或存储", async () => {
    const embed = vi.fn().mockResolvedValue(Array(64).fill(1));
    const {social,state,set} = recoveryFixture(embed);
    const before = structuredClone(state);
    expect((await social.retrieve("chat-1","出门散步",signal())).map(a=>a.id)).toEqual(["missing"]);
    expect((await social.retrieve("chat-1","出门散步",signal())).map(a=>a.id)).toEqual(["missing"]);
    expect(embed.mock.calls.map(c=>c[0])).toEqual(["出门散步","明天去公园","出门散步"]);
    expect(state).toEqual(before);
    expect(set).not.toHaveBeenCalled();
  });

  it("复用已有向量，不重复恢复", async () => {
    const embed = vi.fn().mockResolvedValue(Array(64).fill(1));
    const {social,set} = recoveryFixture(embed,Array(64).fill(1));
    expect(await social.retrieve("chat-1","散步",signal())).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it("恢复失败后可以重试，不缓存失败结果", async () => {
    const embed = vi.fn().mockResolvedValue(Array(64).fill(1));
    embed.mockResolvedValueOnce(Array(64).fill(1)).mockRejectedValueOnce(Error("offline"));
    const {social,set} = recoveryFixture(embed);
    expect(await social.retrieve("chat-1","散步",signal())).toEqual([]);
    expect(await social.retrieve("chat-1","散步",signal())).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(4);
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["invalidate","abort"])("恢复途中失效不返回旧证据：%s", async action => {
    let finish!: (value:number[])=>void;
    const embed = vi.fn().mockResolvedValueOnce(Array(64).fill(1))
      .mockImplementationOnce(()=>new Promise<number[]>(resolve=>{finish=resolve;}));
    const {social,set} = recoveryFixture(embed);
    const control = new AbortController();
    const pending = social.retrieve("chat-1","散步",control.signal);
    await vi.waitFor(()=>expect(embed).toHaveBeenCalledTimes(2));
    if(action==="invalidate") social.invalidate("chat-1",true,[]); else control.abort();
    const writes = set.mock.calls.length;
    finish(Array(64).fill(1));
    expect(await pending).toEqual([]);
    expect(set).toHaveBeenCalledTimes(writes);
  });

  it.each([undefined, "Invalid/Zone", "America/New_York", " Asia/Tokyo "])("抽取沿用用户时区并兼容旧记录：%s", async timezone => {
    const { social, generate, turn } = fixture();
    await social.extract({ ...turn("time", "明天早上八点去复诊"), timezone }, signal());
    const expected = timezone === "America/New_York" ? timezone : timezone === " Asia/Tokyo " ? "Asia/Tokyo" : "Asia/Shanghai";
    expect(generate.mock.calls[0][0]).toContain(`时区=${expected}`);
    expect(generate.mock.calls[0][0]).toContain("2026-09-20T07:59:59.000Z");
  });

  it("维护超过200条时优先保留刚更新的旧事项且不改存储顺序", async () => {
    const at = Date.parse("2026-10-13T04:00:00Z");
    const state = { version: 1, atoms: Array.from({length:201}, (_, i) => ({
      id:`atom-${i}`, conversationId:"chat-1", type:"short_term", content:"明天去公园", evidenceQuote:"明天去公园",
      evidenceTurnId:`source-${i}`, createdAt:at-1000, updatedAt:at-i, expiresAt:at+1000, status:"active",
    })) };
    const before = structuredClone(state);
    const set = vi.fn();
    const generate = vi.fn().mockResolvedValue("[]");
    const social = createSocialContext({get:()=>state as never,set,rootDir:()=>"unused"},generate,undefined,()=>at);
    await social.extract(fixture(at).turn("maintenance","明天再聊"),signal());
    const line = generate.mock.calls[0][0].split("\n").find((s: string)=>s.startsWith("已有候选："));
    const candidates = JSON.parse(line.slice("已有候选：".length));
    expect(candidates.map((a: {id:string})=>a.id)).toEqual(state.atoms.slice(0,200).map(a=>a.id));
    expect(state).toEqual(before);
    expect(set).not.toHaveBeenCalled();
  });

  it("拒绝已经失效的排队来源，不消耗模型调用", async () => {
    const generate = vi.fn();
    const social = createSocialContext({get:()=>undefined,set:()=>{},rootDir:()=>"unused"}, generate, undefined, Date.now, {isCurrent:()=>false});
    await social.extract(fixture().turn("old", "明天去公园"), signal());
    expect(generate).not.toHaveBeenCalled();
  });

  it("明确事件结束后只提供历史背景，不把存储TTL当作事件期限", async () => {
    const {social,generate,turn,setNow,data} = fixture();
    generate.mockResolvedValueOnce(JSON.stringify([{action:"add",type:"short_term",evidenceQuote:"今天去公园",eventEnd:"2026-09-20T23:59:00+08:00",timeEvidenceQuote:"今天"}]));
    await social.extract(turn("event", "今天去公园"), signal());
    const stored = structuredClone(data.get("social-context-state"));
    setNow(Date.parse("2026-09-21T08:00:00Z"));
    expect(social.view().active).toBe(0);
    expect(await social.retrieve("chat-1", "今天去公园", signal())).toEqual([]);
    expect(data.get("social-context-state")).toEqual(stored);
  });
  it("只接受带逐字用户证据的结构化结果，并按同一会话检索", async () => {
    const { social, generate, turn } = fixture();
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "add", type: "short_term", content: "用户明天要去复诊并等待结果", evidenceQuote: "明天要去复诊" },
      { action: "add", type: "open_loop", content: "复诊结束后继续聊检查结果", evidenceQuote: "复诊完再聊结果" },
      { action: "add", type: "short_term", content: "无效猜测", evidenceQuote: "用户没有说过" },
    ]));
    await social.extract(turn("turn-1", "我明天要去复诊，复诊完再聊结果"), signal());
    expect(social.view()).toMatchObject({ total: 2, active: 2 });
    const selected = await social.retrieve("chat-1", "复诊完再聊结果", signal());
    expect(selected.some((atom) => atom.type === "open_loop")).toBe(true);
    expect(await social.retrieve("chat-2", "复诊结束后继续聊检查结果", signal())).toEqual([]);
    const block = social.buildBlock(selected, "Asia/Shanghai");
    expect(block).toContain("尚未接上的话题");
    expect(block).toContain("15:59"); // Source time, not extraction completion time.
    expect(block).not.toContain("用户明天要去复诊并等待结果");
  });

  it("过期事项只能作为历史召回，读取不续期或改写", async () => {
    const start = Date.parse("2026-09-01T00:00:00Z");
    const { social, generate, turn, setNow, data } = fixture(start);
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "add", type: "short_term", content: "用户本周正在准备考试复习计划", evidenceQuote: "本周正在准备考试" },
      { action: "add", type: "open_loop", content: "考试结束后继续聊考试结果", evidenceQuote: "考完以后继续聊结果" },
    ]));
    await social.extract(turn("turn-1", "我本周正在准备考试，考完以后继续聊结果"), signal());
    const before = structuredClone(data.get("social-context-state"));
    setNow(start + 4 * 86_400_000);
    expect((await social.retrieve("chat-1", "考试结束后的考试结果", signal())).some((atom) => atom.type === "open_loop")).toBe(false);
    expect((await social.retrieve("chat-1", "之前考完以后继续聊结果", signal())).some((atom) => atom.type === "open_loop")).toBe(true);
    setNow(start + 15 * 86_400_000);
    expect((await social.retrieve("chat-1", "用户本周正在准备考试复习计划", signal())).some((atom) => atom.type === "short_term")).toBe(false);
    const historical = await social.retrieve("chat-1", "还记得本周正在准备考试", signal());
    expect(historical.length).toBeGreaterThan(0);
    expect(social.buildBlock(historical)).toContain("历史背景（不是当前状态或待办）");
    expect(data.get("social-context-state")).toEqual(before);
  });

  it("抽取等待期间删除来源，不允许重新写回", async () => {
    const { social, generate, turn, data } = fixture();
    let finish!: (text: string) => void;
    generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = social.extract(turn("deleted", "明天一起去公园"), signal());
    social.invalidate("chat-1", false, ["deleted"]);
    finish(JSON.stringify([{action:"add",type:"short_term",evidenceQuote:"明天一起去公园"}]));
    await pending;
    expect(data.has("social-context-state")).toBe(false);
  });

  it("维护候选不受回复三条限制，取消后不再召回", async () => {
    const { social, generate, turn, data } = fixture();
    for (let i = 0; i < 5; i++) {
      generate.mockResolvedValueOnce(JSON.stringify([{action:"add",type:"short_term",evidenceQuote:`明天去地点${i}`} ]));
      await social.extract(turn(`turn-${i}`, `明天去地点${i}`), signal());
    }
    const target = (data.get("social-context-state") as any).atoms[4];
    generate.mockResolvedValueOnce(JSON.stringify([{action:"cancel",targetId:target.id,evidenceQuote:"取消地点4安排"}]));
    await social.extract(turn("cancel", "取消地点4安排"), signal());
    expect(generate.mock.calls.at(-1)?.[0]).toContain(target.id);
    expect((data.get("social-context-state") as any).atoms[4].status).toBe("cancelled");
    expect((await social.retrieve("chat-1", "之前明天去地点4", signal())).some(a => a.id === target.id)).toBe(false);
  });

  it("嵌入等待期间删除也不能提交旧副本", async () => {
    const data = new Map<string, unknown>();
    const storage: PluginStorage = {get: key => data.get(key) as never, set:(key,value)=>{data.set(key,value);},rootDir:()=>"unused"};
    let finish!: () => void;
    const embed = vi.fn(() => new Promise<number[]>(resolve => {finish=()=>resolve(Array(64).fill(1));}));
    const social = createSocialContext(storage, async()=>JSON.stringify([{action:"add",type:"short_term",evidenceQuote:"明天去公园"}]), embed);
    const pending = social.extract(fixture().turn("deleted", "明天去公园"), signal());
    await vi.waitFor(()=>expect(embed).toHaveBeenCalledTimes(1));
    social.invalidate("chat-1", true, []);
    finish(); await pending;
    expect(data.has("social-context-state")).toBe(false);
  });

  it("仅能用本轮用户逐字证据关闭已检索的未完话题", async () => {
    const { social, generate, data, turn } = fixture();
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "add", type: "open_loop", content: "完成报告后继续讨论结论", evidenceQuote: "写完报告再聊结论" },
    ]));
    await social.extract(turn("turn-1", "我写完报告再聊结论"), signal());
    const atom = (data.get("social-context-state") as any).atoms[0];
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "resolve", targetId: atom.id, evidenceQuote: "报告已经写完了" },
    ]));
    await social.extract(turn("turn-2", "完成报告后继续讨论结论，报告已经写完了"), signal());
    expect(social.view()).toMatchObject({ total: 1, active: 0 });
  });
});
