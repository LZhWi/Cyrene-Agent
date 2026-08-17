// Global type augmentations for renderer

import type { ReviewSnapshot } from "../shared/review-types";

interface SystemApi {
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

interface ReviewApi {
  get: (runId: string) => Promise<ReviewSnapshot | null>;
}

declare global {
  interface Window {
    system?: SystemApi;
    review?: ReviewApi;
  }
}

// Vite ?raw 导入：把 .md 文件内联为字符串（renderMarkdown 渲染用）
declare module "*.md?raw" {
  const content: string;
  export default content;
}

export {};
