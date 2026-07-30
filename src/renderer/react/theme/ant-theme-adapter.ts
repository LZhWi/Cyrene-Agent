import type { ThemeConfig } from "antd";
import type { SemanticTokens } from "./semantic-tokens";
import { primitiveTokens } from "./primitive-tokens";

export function buildAntTheme(tokens: SemanticTokens): ThemeConfig {
  return {
    cssVar: true,
    token: {
      colorPrimary: tokens.accent.primary,
      colorBgBase: tokens.background.primary,
      colorTextBase: tokens.text.default,
      colorBorder: tokens.border.soft,
      colorBgContainer: tokens.background.elevated,
      colorBgElevated: tokens.background.elevated,
      colorText: tokens.text.default,
      colorTextSecondary: tokens.text.muted,
      colorTextTertiary: tokens.text.faint,
      borderRadius: Number.parseInt(primitiveTokens.radius.lg),
      fontFamily: primitiveTokens.fontFamily.sans,
      colorSuccess: tokens.status.success,
      colorError: tokens.status.error,
      colorWarning: tokens.status.warning,
      colorInfo: tokens.status.info,
    },
    components: {
      Button: {
        borderRadius: Number.parseInt(primitiveTokens.radius.lg),
        controlHeight: 40,
      },
      Input: {
        borderRadius: 24,
        controlHeight: 48,
      },
      Modal: {
        borderRadiusLG: Number.parseInt(primitiveTokens.radius.xxl),
      },
      Tooltip: {
        borderRadius: Number.parseInt(primitiveTokens.radius.md),
      },
    },
  };
}
