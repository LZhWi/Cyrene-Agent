import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");
const component = readFileSync(resolve(__dirname, "ChatMessageList.tsx"), "utf8");

describe("chat reading width", () => {
  it("uses one responsive reading width for answers and run activity", () => {
    expect(stylesheet).toContain("--cy-message-reading-width: min(100%, clamp(640px, calc(100vw - 560px), 1120px))");
    expect(stylesheet).toMatch(/\.cy-message--assistant \.ant-bubble-body \{[\s\S]*max-width: var\(--cy-message-reading-width\)/);
    expect(stylesheet).toMatch(/\.cy-message--activity \{[\s\S]*width: var\(--cy-message-reading-width\)/);
  });

  it("uses the available chat width only when assistant bubbles are disabled", () => {
    expect(stylesheet).toMatch(
      /:root\[data-assistant-bubble="off"\] \.cy-message--assistant \.ant-bubble-body \{[\s\S]*width: calc\(100% - 54px\)[\s\S]*max-width: calc\(100% - 54px\)/,
    );
  });

  it("keeps the Cyrene-Agent Chat presentation values scoped to Chat mode", () => {
    expect(stylesheet).toMatch(
      /\.cy-page\.is-chat-mode \.cy-message__user-bubble \{[\s\S]*border: 1px solid #ff5b8a;[\s\S]*background: #ff5b8a;/,
    );
    expect(stylesheet).toMatch(
      /\.cy-page\.is-chat-mode \.cy-message-markdown \{[\s\S]*font-size: 16px;/,
    );
    expect(stylesheet).toMatch(
      /\.cy-page\.is-chat-mode \.cy-message-list--stickers-standard \{[\s\S]*--cy-sticker-width: 140px;[\s\S]*--cy-sticker-height: 180px;/,
    );
    expect(stylesheet).toMatch(
      /\.cy-page\.is-chat-mode \.cy-message--user \.ant-bubble-footer \{[\s\S]*flex-direction: row;[\s\S]*justify-content: flex-end;/,
    );
    expect(stylesheet).toMatch(
      /\.cy-page\.is-chat-mode \.ant-bubble-list \.cy-message\.ant-bubble-start,[\s\S]*\.cy-message\.ant-bubble-end \{[\s\S]*padding-inline: 0;/,
    );
    expect(stylesheet).toMatch(
      /\.cy-page\.is-chat-mode \.cy-message \{[\s\S]*width: auto;[\s\S]*max-width: 70%;[\s\S]*column-gap: 14px;/,
    );
  });
});

describe("Chat assistant action bar", () => {
  it("keeps Work's regenerate button as the rightmost action, after archived recall", () => {
    expect(component).toMatch(/<ColdRecallButton[^>]*\/>[\s\S]*<LastTurnActionButton kind="regenerate"[^>]*\/>[\s\S]*<MessageTime/);
    expect(stylesheet).toContain(".cy-page.is-chat-mode .cy-last-turn-action--edit {");
    expect(stylesheet).not.toContain(".cy-page.is-chat-mode .cy-last-turn-action {");
  });
});
