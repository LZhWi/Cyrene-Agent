import { ExecutionLedger } from '../orchestrator/execution-ledger';
import { requireStorageRuntime } from './storage-backend';
import { app } from 'electron';

export function createPersistentExecutionLedger(scope: string): ExecutionLedger | undefined {
  // CLI and headless runners do not own an Electron profile.
  if (!app?.getPath) return undefined;
  const owner = requireStorageRuntime();
  return new ExecutionLedger({
    begin: (id, fingerprint) => owner.callAsync('tools.begin', scope, id, fingerprint),
    // The matching Harness checkpoint commits the model-visible result and receipt
    // together. An interrupted ready receipt stays uncertain after restart.
    finish: (id, fingerprint, outcome) => owner.callAsync('tools.finish', scope, id, fingerprint, outcome, true),
  });
}
