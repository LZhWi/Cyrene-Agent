import type { ReactNode } from "react";
import { CyreneThemeProvider } from "../../theme/CyreneThemeProvider";
import { ThemeProvider, useTheme } from "../../shared/hooks/useTheme";

interface AppProvidersProps {
  children: ReactNode;
}

function ThemeBridge({ children }: { children: ReactNode }) {
  const { mode } = useTheme();
  return <CyreneThemeProvider mode={mode}>{children}</CyreneThemeProvider>;
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <ThemeProvider>
      <ThemeBridge>{children}</ThemeBridge>
    </ThemeProvider>
  );
}
