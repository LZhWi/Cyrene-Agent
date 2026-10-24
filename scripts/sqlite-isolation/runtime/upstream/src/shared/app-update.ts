export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not_available"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  releaseNotes?: string | null;
  /** 错误码（check_failed / download_failed），文案由渲染层翻译；未知码按通用失败处理 */
  error?: string;
}

export interface AppUpdateApi {
  getState(): Promise<AppUpdateState>;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  install(): Promise<boolean>;
  onStateChanged(listener: (state: AppUpdateState) => void): () => void;
}
