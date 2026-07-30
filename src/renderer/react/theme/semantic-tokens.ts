import { primitiveTokens } from "./primitive-tokens";

export const semanticTokens = {
  background: {
    primary: primitiveTokens.color.black,
    secondary: "#0f0d1f",
    tertiary: "#181432",
    elevated: "#2a2350",
  },

  text: {
    strong: "#fef7ff",
    default: "#ebe5f5",
    muted: "#a094c1",
    faint: "#6b6388",
    onAccent: "#ffffff",
  },

  border: {
    faint: "rgba(236, 72, 153, 0.08)",
    soft: "rgba(236, 72, 153, 0.18)",
    strong: "rgba(236, 72, 153, 0.40)",
  },

  accent: {
    primary: primitiveTokens.color.pink500,
    primaryHover: primitiveTokens.color.pink600,
    glow: primitiveTokens.color.pinkGlow,
    gradient: `linear-gradient(135deg, ${primitiveTokens.color.pink500} 0%, ${primitiveTokens.color.violet500} 100%)`,
  },

  message: {
    userBackground: `linear-gradient(135deg, ${primitiveTokens.color.pink500} 0%, ${primitiveTokens.color.violet500} 100%)`,
    assistantBackground: "rgba(255, 255, 255, 0.08)",
  },

  status: {
    error: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
    info: "#3b82f6",
  },
} as const;

export type SemanticTokens = typeof semanticTokens;
