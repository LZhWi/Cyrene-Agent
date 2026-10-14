import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const mocks = vi.hoisted(() => ({ dir: "", getSession: vi.fn(), buildRequest: vi.fn(), operations: [] as unknown[] }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.dir } }));
vi.mock("../chats/chats-store", () => ({ getSession: mocks.getSession }));
vi.mock("../orchestrator/vendors", () => ({ getAdapterForConfig: () => ({
  buildRequest: mocks.buildRequest, parseResponse: () => ({ text: JSON.stringify(mocks.operations) }),
}) }));
import {
  buildSocialContextBlock, captureSocialSourceRevision, deleteSocialContextByTurnIds,
  deleteSocialContextForConversation, extractAndStoreSocialContext, flushSocialContextDiagnostics,
  retrieveSocialContext, retrieveSocialContextReadOnly, type SocialAtom, type SocialTurnContext,
} from "./index";

const DAY = 86400000;
const now = Date.now();
let message: { id: string; role: string; content: string; at: number };
const store = () => path.join(mocks.dir, "chat-social-atoms.json");
const read = (): SocialAtom[] => JSON.parse(fs.readFileSync(store(), "utf8")).atoms;
const write = (atoms: SocialAtom[]) => fs.writeFileSync(store(), JSON.stringify({ version: 1, atoms }));
const atom = (overrides: Partial<SocialAtom> = {}): SocialAtom => ({
  id: "old", conversationId: "s", type: "short_term", content: "明天去学校", evidenceQuote: "明天去学校",
  evidenceTurnId: "old-user", createdAt: now - DAY, updatedAt: now - DAY, expiresAt: now + DAY,
  status: "active", ...overrides,
});
const turn = (): SocialTurnContext => ({ conversationId: "s", userTurnId: "u", assistantTurnId: "a",
  userText: message.content, retrievedAtoms: [], sourceRevision: captureSocialSourceRevision("s", "u") });
const run = (context = turn(), reply = "好的") => extractAndStoreSocialContext(context, reply, {} as never);
const add = (quote = message.content) => ({ action: "add", type: "short_term", evidenceQuote: quote });

beforeEach(() => {
  mocks.dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-lifecycle-"));
  message = { id: "u", role: "user", content: "明天去学校", at: now };
  mocks.getSession.mockImplementation(() => ({ messages: [message] }));
  mocks.operations = [];
  mocks.buildRequest.mockReset().mockReturnValue({ url: "https://fixture.invalid", headers: {}, body: "" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  write([]);
});
afterEach(async () => {
  await flushSocialContextDiagnostics();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  fs.rmSync(mocks.dir, { recursive: true, force: true });
});

describe("social lifecycle", () => {
  it.each([retrieveSocialContext, retrieveSocialContextReadOnly])("never renews archived evidence during retrieval", async retrieve => {
    write([atom({ status: "archived", createdAt: now - 60 * DAY, expiresAt: now - DAY })]);
    const before = fs.readFileSync(store(), "utf8");
    const hits = await retrieve("s", "还记得明天去学校吗", { embed: async () => [1] } as never);
    expect(hits).toHaveLength(1);
    expect(buildSocialContextBlock(hits)).toContain("历史背景（已过期，不是当前状态或待办）");
    expect(fs.readFileSync(store(), "utf8")).toBe(before);
  });
  it("does not treat legacy retrieval renewal as confirmation", async () => {
    write([atom({ createdAt: now - 60 * DAY, updatedAt: now, expiresAt: now + DAY })]);
    expect(await retrieveSocialContext("s", "学校安排", { embed: async () => [1] } as never)).toEqual([]);
    expect(read()[0].status).toBe("active");
  });
  it("retains only quoted evidence instead of an unsupported summary", async () => {
    message.content = "你好";
    mocks.operations = [{ ...add(), content: "用户已经买好去火星的机票" }];
    await run();
    expect(read()[0].content).toBe("你好");
    expect(buildSocialContextBlock(read())).not.toContain("火星");
  });
  it("validates assistant promises against assistant text and preserves speaker", async () => {
    mocks.operations = [{ ...add("我答应今晚早睡"), evidenceRole: "assistant" }];
    await run(turn(), "我答应今晚早睡");
    expect(read()[0]).toMatchObject({ evidenceRole: "assistant", evidenceTurnId: "a", sourceUserTurnId: "u" });
    expect(buildSocialContextBlock(read())).toContain("助手原话");
    deleteSocialContextByTurnIds("s", ["u"]);
    expect(read()).toEqual([]);
  });
  it("rejects invented or oversized quotes", async () => {
    mocks.operations = [add("根本不存在"), add("长".repeat(241))];
    await run(); expect(read()).toEqual([]);
  });
  it("updates confirmation provenance but retains first formation time", async () => {
    const original = atom(); write([original]); mocks.operations = [add()];
    await run();
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({ createdAt: original.createdAt, lastConfirmedAt: now, evidenceTurnId: "u", evidenceRole: "user" });
  });
  it("reconfirms legacy summaries by the exact evidence quote without duplicating them", async () => {
    write([atom({ content: "用户明天计划去学校" })]); mocks.operations = [add()];
    await run(); expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({ id: "old", content: message.content, evidenceTurnId: "u" });
  });
  it("rejects queued work whose source conversation no longer exists", async () => {
    const context = turn(); mocks.getSession.mockReturnValue(null); mocks.operations = [add()];
    await run(context); expect(fetch).not.toHaveBeenCalled(); expect(read()).toEqual([]);
  });
  it("records request failures without persisting partial operations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture offline"); }));
    await expect(run()).rejects.toThrow("fixture offline");
    await flushSocialContextDiagnostics();
    const log = JSON.parse(fs.readFileSync(path.join(mocks.dir, "logs/social-context.jsonl"), "utf8"));
    expect(log).toMatchObject({ reason: "failed", userTurnId: "u" }); expect(read()).toEqual([]);
  });
  it.each(["resolve", "cancel"])("can %s a short-term item outside reply Top3", async action => {
    write([atom()]); message.content = "学校的行程已经取消了";
    mocks.operations = [{ action, targetId: "old", evidenceQuote: message.content }];
    await run();
    expect(read()[0].status).toBe(action === "resolve" ? "resolved" : "cancelled");
    expect(JSON.stringify(mocks.buildRequest.mock.calls[0][0])).toContain("old");
  });
  it("supersedes an old plan with source-backed replacement", async () => {
    write([atom()]); message.content = "改成后天去学校";
    mocks.operations = [{ ...add(), action: "supersede", targetId: "old" }];
    await run(); expect(read().map(a => a.status)).toEqual(["superseded", "active"]);
    expect(read()[1].content).toBe(message.content);
  });
  it("rejects unknown or cross-session closure targets", async () => {
    write([atom({ conversationId: "other" })]); mocks.operations = [{ action: "resolve", targetId: "old", evidenceQuote: message.content }];
    await run(); expect(read()[0].status).toBe("active");
  });
  it("rejects queued work after source editing", async () => {
    const context = turn(); message.content = "改了"; mocks.operations = [add()];
    await run(context); expect(fetch).not.toHaveBeenCalled(); expect(read()).toEqual([]);
  });
  it.each(["conversation", "turn", "edit"])("rejects in-flight writes after %s changes", async change => {
    let release!: (response: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { release = resolve; })));
    mocks.operations = [add()]; const work = run();
    if (change === "conversation") deleteSocialContextForConversation("s");
    else if (change === "turn") deleteSocialContextByTurnIds("s", ["u"]);
    else message.content = "改了";
    release({ ok: true, json: async () => ({}) }); await work;
    expect(read()).toEqual([]);
  });
  it("does not overwrite a target updated during the request", async () => {
    write([atom()]); let release!: (response: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { release = resolve; })));
    mocks.operations = [{ action: "cancel", targetId: "old", evidenceQuote: message.content }];
    const work = run(); write([atom({ lastConfirmedAt: now + 1 })]);
    release({ ok: true, json: async () => ({}) }); await work;
    expect(read()[0].status).toBe("active");
  });
  it("separates event end from retention and shows past events only as history", async () => {
    message.content = "昨天去学校了";
    mocks.operations = [{ ...add(), timeEvidenceQuote: "昨天", eventEnd: new Date(now - 1000).toISOString() }];
    await run(); expect(read()[0].expiresAt).toBeGreaterThan(now);
    expect(buildSocialContextBlock(read())).toContain("历史背景（已过期，不是当前状态或待办）");
  });
  it("leaves ambiguous or ungrounded dates unset", async () => {
    mocks.operations = [{ ...add(), timeEvidenceQuote: "下个月", eventEnd: "2030-01-01T00:00:00Z" }];
    await run(); expect(read()[0].eventEndAt).toBeUndefined();
    expect(buildSocialContextBlock(read())).toContain("事项时间未核实");
  });
  it("records selected IDs and original evidence without changing the store", async () => {
    write([atom()]); const before = fs.readFileSync(store(), "utf8");
    await retrieveSocialContext("s", "学校安排", { embed: async () => [1] } as never);
    await flushSocialContextDiagnostics();
    const log = JSON.parse(fs.readFileSync(path.join(mocks.dir, "logs/social-context.jsonl"), "utf8"));
    expect(log.selected[0]).toMatchObject({ id: "old", evidenceTurnId: "old-user" });
    expect(fs.readFileSync(store(), "utf8")).toBe(before);
  });
  it("ignores logging failures", async () => {
    fs.writeFileSync(path.join(mocks.dir, "logs"), "not a directory");
    await expect(retrieveSocialContext("s", "anything")).resolves.toEqual([]);
    await expect(flushSocialContextDiagnostics()).resolves.toBeUndefined();
  });
});
