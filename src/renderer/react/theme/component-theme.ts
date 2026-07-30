import type { SemanticTokens } from "./semantic-tokens";
import { primitiveTokens } from "./primitive-tokens";

export function buildComponentTheme(tokens: SemanticTokens) {
  return {
    button: {
      primaryBg: tokens.accent.primary,
      primaryColor: tokens.text.onAccent,
      primaryHoverBg: tokens.accent.primaryHover,
      ghostBg: "transparent",
      ghostColor: tokens.text.default,
      ghostHoverBg: tokens.border.faint,
      borderRadius: primitiveTokens.radius.lg,
    },
    input: {
      bg: "rgba(255, 255, 255, 0.08)",
      border: tokens.border.soft,
      focusBorder: tokens.border.strong,
      color: tokens.text.default,
      placeholderColor: tokens.text.faint,
      borderRadius: "24px",
    },
    bubble: {
      userBg: tokens.message.userBackground,
      userColor: tokens.text.onAccent,
      assistantBg: tokens.message.assistantBackground,
      assistantColor: tokens.text.default,
      borderRadius: "20px",
    },
    sidebar: {
      bg: "rgba(255, 255, 255, 0.04)",
      borderRight: tokens.border.soft,
      itemHoverBg: tokens.border.faint,
      itemActiveBg: tokens.border.soft,
    },
    header: {
      bg: "linear-gradient(180deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.025))",
      borderBottom: tokens.border.soft,
    },
  } as const;
}

export type ComponentTheme = ReturnType<typeof buildComponentTheme>;
