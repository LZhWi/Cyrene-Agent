import type { ReactNode } from "react";

interface AppProvidersProps {
  children: ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  return <>{children}</>;
}
