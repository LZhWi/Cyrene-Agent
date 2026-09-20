import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWechatRecipient,
  deleteWechatRecipient,
  rememberWechatRecipientContext,
  rememberWechatRecipientSession,
} from "./recipient-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("wechat recipient store", () => {
  it("merges context token and desktop session for the latest sole recipient", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wechat-recipient-"));
    roots.push(root);
    const filePath = path.join(root, "recipient.json");

    rememberWechatRecipientContext({
      botId: "bot-1",
      targetId: "wx-user-1",
      contextToken: "ctx-1",
      updatedAt: 100,
    }, filePath);
    rememberWechatRecipientSession({
      targetId: "wx-user-1",
      sessionId: "channel:wechat:one",
      updatedAt: 200,
    }, filePath);

    expect(loadWechatRecipient(filePath)).toEqual({
      botId: "bot-1",
      targetId: "wx-user-1",
      contextToken: "ctx-1",
      sessionId: "channel:wechat:one",
      updatedAt: 200,
    });
  });

  it("does not carry the previous recipient credentials to a different target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wechat-recipient-"));
    roots.push(root);
    const filePath = path.join(root, "recipient.json");
    rememberWechatRecipientContext({ targetId: "wx-old", contextToken: "ctx-old" }, filePath);
    rememberWechatRecipientSession({ targetId: "wx-new", sessionId: "session-new" }, filePath);

    expect(loadWechatRecipient(filePath)).toMatchObject({
      targetId: "wx-new",
      sessionId: "session-new",
    });
    expect(loadWechatRecipient(filePath)?.contextToken).toBeUndefined();
  });

  it("clears the persisted recipient on logout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wechat-recipient-"));
    roots.push(root);
    const filePath = path.join(root, "recipient.json");
    rememberWechatRecipientContext({ targetId: "wx-user", contextToken: "ctx" }, filePath);

    deleteWechatRecipient(filePath);

    expect(loadWechatRecipient(filePath)).toBeNull();
  });
});
