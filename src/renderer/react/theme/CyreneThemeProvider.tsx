import { createContext, useContext, useMemo, useEffect, type ReactNode } from "react";
import { ConfigProvider, theme as antTheme } from "antd";
import type { ThemeConfig } from "antd";

type ThemeMode = "dark" | "light";

interface CyreneThemeContextValue {
  mode: ThemeMode;
}

const CyreneThemeContext = createContext<CyreneThemeContextValue | null>(null);

export function useCyreneTheme(): CyreneThemeContextValue {
  const ctx = useContext(CyreneThemeContext);
  if (!ctx) throw new Error("useCyreneTheme must be used within CyreneThemeProvider");
  return ctx;
}

// 主题定义：所有颜色在这里控制
const themeDefinitions: Record<ThemeMode, Record<string, string>> = {
  dark: {
    "--cy-bg": "#08070f",
    "--cy-bg-secondary": "rgba(255, 255, 255, 0.04)",
    "--cy-bg-elevated": "rgba(255, 255, 255, 0.08)",
    "--cy-text": "#ebe5f5",
    "--cy-text-muted": "#a094c1",
    "--cy-border": "rgba(236, 72, 153, 0.18)",
    "--cy-accent": "#ec4899",
  },
  light: {
    "--cy-bg": "#ffffff",
    "--cy-bg-secondary": "#f5f5f7",
    "--cy-bg-elevated": "#ffffff",
    "--cy-text": "#1d1d1f",
    "--cy-text-muted": "#6f6876",
    "--cy-border": "#e5e5ea",
    "--cy-accent": "#ff5b8a",
  },
};

// Ant Design 主题配置
function buildAntThemeConfig(mode: ThemeMode): ThemeConfig {
  const defs = themeDefinitions[mode];
  return {
    cssVar: true,
    token: {
      colorPrimary: defs["--cy-accent"],
      colorBgBase: defs["--cy-bg"],
      colorTextBase: defs["--cy-text"],
      colorBorder: defs["--cy-border"],
      borderRadius: 12,
      fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
  };
}

interface CyreneThemeProviderProps {
  children: ReactNode;
  mode?: ThemeMode;
}

export function CyreneThemeProvider({ children, mode = "dark" }: CyreneThemeProviderProps) {
  const antThemeConfig = useMemo(() => buildAntThemeConfig(mode), [mode]);

  // 把主题颜色注入到 CSS 变量
  useEffect(() => {
    const root = document.documentElement;
    const defs = themeDefinitions[mode];
    for (const [key, value] of Object.entries(defs)) {
      root.style.setProperty(key, value);
    }
    root.dataset.theme = mode;
  }, [mode]);

  return (
    <CyreneThemeContext.Provider value={{ mode }}>
      <ConfigProvider
        theme={{
          ...antThemeConfig,
          algorithm: mode === "dark" ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        }}
      >
        {children}
      </ConfigProvider>
    </CyreneThemeContext.Provider>
  );
}
