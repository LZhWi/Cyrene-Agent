// Shared music state-machine types used by both main and renderer.
// Keep this file free of electron / node imports so it can be consumed
// from the renderer bundle without layering violations.

export type MusicBackendState =
  | "stopped" | "starting" | "ready" | "degraded" | "incompatible" | "failed";

export type MusicAccountState =
  | "unknown" | "signed_out" | "validating" | "signed_in" | "expired" | "temporarily_unavailable";

export type MusicPlayerState = "unknown" | "available" | "unavailable";

export type LoginFlowState =
  | "idle" | "creating_qr" | "waiting_scan" | "waiting_confirm"
  | "authorized" | "expired" | "cancelled" | "failed";