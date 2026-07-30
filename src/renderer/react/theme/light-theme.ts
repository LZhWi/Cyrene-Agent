import { primitiveTokens } from "./primitive-tokens";
import type { SemanticTokens } from "./semantic-tokens";

export const lightTheme: SemanticTokens = {
  background: {
    primary: "#ffffff",
    secondary: "#f5f5f7",
    tertiary: "#fafafc",
    elevated: "#ffffff",
  },

  text: {
    strong: "#1d1d1f",
    default: "#2c2c2e",
    muted: "#4f4a57",
    faint: "#6f6876",
    onAccent: "#ffffff",
  },

  border: {
    faint: "rgba(0, 0, 0, 0.06)",
    soft: "#e5e5ea",
    strong: "#d2d2d7",
  },

  accent: {
    primary: "#ff5b8a",
    primaryHover: "#e84a78",
    glow: "#ff6ec7",
    gradient: `linear-gradient(135deg, #ff5b8a 0%, ${primitiveTokens.color.violet500} 100%)`,
  },

  message: {
    userBackground: "#ff5b8a",
    assistantBackground: "#f5f5f7",
  },

  status: {
    error: "#b91c1c",
    success: "#15803d",
    warning: "#92400e",
    info: "#1d4ed8",
  },
};
