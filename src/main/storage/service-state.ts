/** Synchronous service stores share the existing SQLite owner; all business stores require an initialized provider. */
export interface ServiceState {
  get(key: string): any;
  set(key: string, value: unknown): void;
  all(): Record<string, any>;
  call(method: string, ...args: unknown[]): any;
}
type Provider = (root: string, namespace: string) => ServiceState | undefined;
let provider: Provider | undefined;
export function setServiceStateProvider(value: Provider) { provider = value; }
export function getServiceState(root: string, namespace: string): ServiceState {
  const state=provider?.(root, namespace);
  if(!state)throw Error('SQLITE_SERVICE_UNAVAILABLE:'+namespace);
  return state;
}
