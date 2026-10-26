import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => "unused" }, BrowserWindow: {}, dialog: {}, shell: {} }));
import { messageSourceFingerprint } from "./chats-ipc";
it("ignores derived vision fields but tracks sticker and attachment source changes", () => {
 const source: any = { id:"u",role:"user",content:"photo",at:1,attachments:[{kind:"image",name:"p",filePath:"p"}] };
 const captioned = {...source,attachments:[{...source.attachments[0],visualIndexCaption:"full",visualIndexSummary:"short",visualIndexedAt:5}]};
 expect(messageSourceFingerprint(captioned)).toBe(messageSourceFingerprint(source));
 expect(messageSourceFingerprint({...captioned,sticker:"hug"})).not.toBe(messageSourceFingerprint(source));
 expect(messageSourceFingerprint({...source,attachments:[]})).not.toBe(messageSourceFingerprint(source));
});
