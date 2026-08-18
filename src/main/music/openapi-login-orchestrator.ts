// OpenAPI QR login orchestrator (M2 rewrite).
//
// Replaces the weapi/Python QR flow with direct OpenAPI QR endpoints:
//   1. loginAnonymous() → anon token (QR endpoints require it)
//   2. getQrCodeKey()   → { qrCodeUrl, uniKey }  (300s validity)
//   3. checkQrLoginStatus(uniKey) → 800/801/802/803
//   4. On 803: persist { accessToken, refreshToken, expireTime } → TokenVault
//
// State machine preserved: idle/creating_qr/waiting_scan/waiting_confirm/
// authorized/expired/cancelled/failed.  Renderer reads `qrContent` only —
// field name kept for compatibility (panel.ts:177).
//
// Coexists with the old LoginOrchestrator until M3 swaps MusicService over.
import type { NeteaseOpenapiClient, OpenapiTokenBundle, QrLoginStatus } from "./netease-openapi-client";
import type { TokenVault } from "./token-vault";
import type { LoginFlowState, MusicAccountState } from "./types";

export interface LoginOrchestratorDeps {
  client: NeteaseOpenapiClient;
  vault: TokenVault;
  /** QR validity window (server default 300s via expiredKey). */
  qrValidityMs?: number;
  /** Poll cadence (PoC: 3s). */
  pollIntervalMs?: number;
}

export type BeginResult =
  | { uniKey: string; qrContent: string; expiresAt: number; pollIntervalMs: number }
  | { status: "login_already_active"; activeSessionId: string };

export type CheckResult =
  | { status: "waiting_scan" }
  | { status: "waiting_confirm" }
  | { status: "authorized"; credentialsPersisted: boolean; profile: { userId: string; nickname: string } }
  | { status: "expired"; errorCode?: string }
  | { status: "cancelled" }
  | { status: "failed"; errorCode?: string };

const TERMINAL: ReadonlyArray<CheckResult["status"]> = ["authorized", "expired", "cancelled", "failed"];

export class OpenapiLoginOrchestrator {
  private flowState: LoginFlowState = "idle";
  private accountState: MusicAccountState = "unknown";
  private uniKey: string | null = null;
  private qrExpiresAt = 0;
  private persisted = false;
  private inFlightCheck = false;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: LoginOrchestratorDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
  }

  getFlowState(): LoginFlowState {
    return this.flowState;
  }

  getAccountState(): MusicAccountState {
    return this.accountState;
  }

  setAccountState(s: MusicAccountState): void {
    this.accountState = s;
  }

  async beginLogin(): Promise<BeginResult> {
    // Reject re-begin while a non-terminal session is active.
    if (this.uniKey && !TERMINAL.includes(this.flowState as CheckResult["status"])) {
      return { status: "login_already_active", activeSessionId: this.uniKey };
    }

    this.flowState = "creating_qr";
    this.persisted = false;

    // QR endpoints require an anonymous token even when a user token exists.
    const anon: OpenapiTokenBundle = await this.deps.client.loginAnonymous();
    this.deps.client.setAccessToken(anon.accessToken);

    const qr = await this.deps.client.getQrCodeKey();
    this.uniKey = qr.uniKey;
    const validityMs = this.deps.qrValidityMs ?? 300_000;
    this.qrExpiresAt = Date.now() + validityMs;
    this.flowState = "waiting_scan";

    return {
      uniKey: qr.uniKey,
      qrContent: qr.qrCodeUrl,
      expiresAt: this.qrExpiresAt,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  async pollOnce(): Promise<CheckResult> {
    if (!this.uniKey) return { status: "failed", errorCode: "E_NO_SESSION" };

    // Terminal states are idempotent — return the cached result.
    if (this.flowState === "authorized") {
      return { status: "authorized", credentialsPersisted: this.persisted, profile: { userId: "", nickname: "" } };
    }
    if (this.flowState === "expired") return { status: "expired" };
    if (this.flowState === "cancelled") return { status: "cancelled" };
    if (this.flowState === "failed") return { status: "failed" };

    // Local expiry guard (server 800 may lag).
    if (Date.now() >= this.qrExpiresAt) {
      this.flowState = "expired";
      return { status: "expired", errorCode: "E_QR_EXPIRED_LOCAL" };
    }

    if (this.inFlightCheck) {
      return { status: "failed", errorCode: "E_CHECK_IN_FLIGHT" };
    }
    this.inFlightCheck = true;
    try {
      const raw = await this.deps.client.checkQrLoginStatus(this.uniKey);
      return this.applyQrStatus(raw);
    } catch (e: unknown) {
      this.flowState = "failed";
      return { status: "failed", errorCode: (e as Error).message.slice(0, 120) };
    } finally {
      this.inFlightCheck = false;
    }
  }

  async cancelLogin(): Promise<void> {
    if (!this.uniKey) return;
    // Late cancel must not overwrite success.
    if (this.flowState === "authorized") return;
    // No server-side cancel endpoint (manifest has none); QR auto-expires in 300s.
    this.flowState = "cancelled";
  }

  async shutdown(): Promise<void> {
    if (!TERMINAL.includes(this.flowState as CheckResult["status"])) {
      await this.cancelLogin();
    }
  }

  /**
   * Startup restore: load persisted token from TokenVault, inject into client,
   * validate by calling getUserProfile. Called once at MusicService boot.
   * Returns true when the session is valid and the client is ready for
   * user-level endpoint calls.
   */
  async restoreSession(): Promise<boolean> {
    const blob = await this.deps.vault.load();
    if (!blob) {
      console.log("[music] restoreSession: 无已保存 token");
      this.accountState = "signed_out";
      return false;
    }
    let bundle;
    try {
      bundle = await this.deps.vault.decrypt(blob);
    } catch (err) {
      console.warn("[music] restoreSession: token 解密失败，按未登录处理", err instanceof Error ? err.message : err);
      this.accountState = "signed_out";
      return false;
    }
    if (!this.deps.vault.isFresh(bundle)) {
      console.log("[music] restoreSession: token 已过期，需要重新登录");
      this.accountState = "expired";
      return false;
    }
    this.deps.client.setAccessToken(bundle.accessToken);
    try {
      await this.deps.client.getUserProfile();
      console.log("[music] restoreSession: token 有效，已恢复登录态");
      this.accountState = "signed_in";
      this.flowState = "authorized";
      this.persisted = true;
      return true;
    } catch (err) {
      console.warn("[music] restoreSession: token 验证失败（getUserProfile），按过期处理", err instanceof Error ? err.message : err);
      this.accountState = "expired";
      return false;
    }
  }

  private applyQrStatus(raw: QrLoginStatus): CheckResult {
    switch (raw.status) {
      case 801:
        this.flowState = "waiting_scan";
        return { status: "waiting_scan" };
      case 802:
        this.flowState = "waiting_confirm";
        return { status: "waiting_confirm" };
      case 800:
        this.flowState = "expired";
        return { status: "expired", errorCode: raw.msg ?? "E_QR_EXPIRED" };
      case 803: {
        this.flowState = "authorized";
        this.accountState = "signed_in";
        const token = raw.accessToken;
        this.deps.client.setAccessToken(token.accessToken);
        if (!this.persisted) {
          this.persisted = true;
          // Fire-and-forget: caller (renderer) doesn't wait on disk I/O.
          void this.deps.vault.persist({
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expireTime: token.expireTime,
            gotAt: Date.now(),
          });
        }
        return { status: "authorized", credentialsPersisted: this.persisted, profile: { userId: "", nickname: "" } };
      }
      default:
        this.flowState = "failed";
        return { status: "failed", errorCode: `E_UNKNOWN_QR_STATUS_${(raw as { status: number }).status}` };
    }
  }
}
