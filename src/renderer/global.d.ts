// Global type augmentations for renderer

interface SystemApi {
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    system?: SystemApi;
  }
}

export {};
