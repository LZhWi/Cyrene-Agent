import type * as legacy from "./chats-store-json";
import { requireStorageRuntime } from "../storage/storage-backend";

// Every caller, including IPC, plugin services and background writers, selects
// the same backend. There is no per-operation fallback into the JSON store.
function forward<K extends keyof typeof legacy>(key: K): typeof legacy[K] {
  return ((...args: unknown[]) => {
    const store = requireStorageRuntime().store;
    return (store[key] as (...args: unknown[]) => unknown)(...args);
  }) as typeof legacy[K];
}
export const initialize = forward("initialize");
export const getRootDir = forward("getRootDir");
export const listSessions = forward("listSessions");
export const getSession = forward("getSession");
export const getSessionPage = forward("getSessionPage");
export const createSession = forward("createSession");
export const getSessionByPurpose = forward("getSessionByPurpose");
export const getOrCreateSessionByPurpose = forward("getOrCreateSessionByPurpose");
export const appendMessage = forward("appendMessage");
export const upsertMessage = forward("upsertMessage");
export const setMessageTtsCacheKey = forward("setMessageTtsCacheKey");
export const setImageVisualIndexResult = forward("setImageVisualIndexResult");
export const markPluginMessageIgnored = forward("markPluginMessageIgnored");
export const replaceMessages = forward("replaceMessages");
export const replaceMessagesTail = forward("replaceMessagesTail");
export const deleteMessageRound = forward("deleteMessageRound");
export const renameSession = forward("renameSession");
export const setSessionPinned = forward("setSessionPinned");
export const setSessionModelProfile = forward("setSessionModelProfile");
export const setSessionContextUsage = forward("setSessionContextUsage");
export const deleteSession = forward("deleteSession");
export const getLatestSessionId = forward("getLatestSessionId");
export const migrateLegacyMessages = forward("migrateLegacyMessages");
export const openStorageFolder = forward("openStorageFolder");
export const setWorkspaceBinding = forward("setWorkspaceBinding");
export const getWorkspaceBinding = forward("getWorkspaceBinding");
export const clearWorkspaceBinding = forward("clearWorkspaceBinding");
export const getStorageRecoveryIssues = forward("getStorageRecoveryIssues");
export const approveStorageRecovery = forward("approveStorageRecovery");
export const appendProactiveMessage = (id: string, input: unknown) => {
  const owner = requireStorageRuntime();
  if (!owner) throw new Error("SQLITE_DELIVERY_UNAVAILABLE");
  return owner.store.appendProactiveMessage(id, input);
};
