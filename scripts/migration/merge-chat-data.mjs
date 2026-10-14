import { isDeepStrictEqual as equal } from 'node:util';

// Three-way merge: source metadata may be rebound, user edits may not be overwritten.
export function mergeRows(current, baseline, incoming, metadata = [], repairMissing = []) {
  const result = structuredClone(current), byId = new Map(result.map(row => [row.id, row]));
  const old = new Map(baseline.map(row => [row.id, row]));
  if (byId.size !== current.length || old.size !== baseline.length || new Set(incoming.map(row => row.id)).size !== incoming.length) throw Error('Duplicate migration row ID');
  for (const row of incoming) {
    const target = byId.get(row.id), prior = old.get(row.id);
    if (!target) { result.push(structuredClone(row)); continue; }
    for (const key of new Set([...Object.keys(row), ...Object.keys(prior ?? {})])) {
      if (equal(target[key], row[key])) continue;
      if (prior && equal(prior[key], row[key]) && !(target[key] === undefined && repairMissing.includes(key))) continue;
      if (!equal(target[key], prior?.[key]) && target[key] !== undefined && !metadata.includes(key)) throw Error(`Migration conflict: ${row.id}.${key}`);
      if (row[key] === undefined) delete target[key]; else target[key] = structuredClone(row[key]);
    }
  }
  return result;
}

export function mergeProfiles(current, baseline, incoming) {
  const result = structuredClone(current);
  for (const layer of ['l0', 'l1']) for (const field of new Set([...Object.keys(baseline[layer]), ...Object.keys(incoming[layer])])) {
    const target = current[layer][field], fresh = incoming[layer][field];
    if (equal(target, fresh)) continue;
    if ((layer === 'l0' && current.l0Locked) || target?.origin === 'user-edit') continue;
    if (!equal(target, baseline[layer][field])) throw Error(`Profile migration conflict: ${layer}.${field}`);
    if (fresh === undefined) delete result[layer][field]; else result[layer][field] = structuredClone(fresh);
  }
  return result;
}

export function mergeSessions(current, incoming) {
  const result = structuredClone(current);
  for (const source of incoming) {
    const target = result.find(row => row.id === source.id);
    if (!target) { result.push(structuredClone(source)); continue; }
    const byId = new Map(target.messages.map(row => [row.id, row]));
    for (const message of source.messages) {
      const old = byId.get(message.id);
      if (!old) target.messages.push(structuredClone(message));
      else if (old.role !== message.role || old.content !== message.content || old.at !== message.at) throw Error(`History migration conflict: ${source.id}/${message.id}`);
      else {
        // Preserve target-only extensions, but carry source event cards and attachment metadata.
        for (const key of Object.keys(message)) if (old[key] === undefined) old[key] = structuredClone(message[key]);
      }
    }
    target.messages.sort((a,b) => a.at - b.at);
  }
  for (const session of result) {
    if (!session.id || session.id.includes('/') || session.id.includes('\\') || session.id === '..') throw Error('Invalid session ID');
    if (new Set(session.messages.map(row => row.id)).size !== session.messages.length) throw Error('Duplicate message IDs');
    session.mode ??= session.purpose === 'proactive-chat' ? 'chat' : 'work';
  }
  return result;
}
