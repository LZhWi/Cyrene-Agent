// Pure mapping from MusicStatusSnapshot → UI view state.
// Lives in src/shared so it can be unit-tested without pulling in the DOM.
// The renderer imports this and the function is a pure value-to-value transform.

import type { LoginFlowState } from "./music-types";

export interface MusicStatusSnapshot {
  backend: string;
  account: string;
  player: string;
  flow: LoginFlowState;
  profile?: { nickname?: string; avatarUrl?: string; avatar?: string } | null;
}

export type NeteaseViewState =
  | "backend_starting"
  | "backend_error"
  | "signed_out"
  | "creating_qr"
  | "waiting_scan"
  | "waiting_confirm"
  | "login_expired"
  | "login_failed"
  | "connected"
  | "connected_without_client";

export function deriveNeteaseViewState(snapshot: MusicStatusSnapshot): NeteaseViewState {
  if (snapshot.backend === "starting") return "backend_starting";
  if (snapshot.backend === "failed" || snapshot.backend === "incompatible") return "backend_error";
  if (snapshot.account !== "signed_in") return "signed_out";
  if (
    snapshot.flow === "creating_qr" ||
    snapshot.flow === "waiting_scan" ||
    snapshot.flow === "waiting_confirm"
  ) {
    return snapshot.flow;
  }
  if (snapshot.flow === "expired") return "login_expired";
  if (snapshot.flow === "failed") return "login_failed";
  return snapshot.player === "available" ? "connected" : "connected_without_client";
}