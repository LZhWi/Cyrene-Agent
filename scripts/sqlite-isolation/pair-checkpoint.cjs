// Isolation-only persistence. Loaded plugins remain the sole business owners.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');
const FILES = ['cyrene.sqlite', 'unified/plugin-state.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value);

function boundary(basePath, formal = false) {
  const base = fs.realpathSync(basePath);
  if (formal) require('./data-boundary.cjs').formalControl(base);
  else if (path.resolve(basePath) !== base || !/^sqlite-candidate-[a-z0-9-]+$/.test(path.basename(base))
    || path.basename(path.dirname(base)) !== '.runtime') throw Error('PAIR_ISOLATION_REQUIRED');
  return value => {
    const target = path.resolve(value), relative = path.relative(base, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('PAIR_ISOLATION_REQUIRED');
    let current = base;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('PAIR_REDIRECTION_REJECTED');
    }
    return target;
  };
}
function writeNew(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function open(file, readOnly = false) {
  if (!fs.existsSync(file)) throw Error('PAIR_DATABASE_MISSING');
  const db = new DatabaseSync(path.toNamespacedPath(file), { readOnly });
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}
function authoritative(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='isolated_plugin_state'").get()) throw Error('PAIR_AUTHORITY_MISSING');
  const rows = db.prepare('SELECT * FROM isolated_plugin_state').all();
  const pairs = db.prepare('SELECT * FROM isolated_pair').all();
  if (rows.length !== 1 || pairs.length !== 1) throw Error('PAIR_AUTHORITY_INVALID');
  const row = rows[0], aggregate = JSON.parse(row.payload_json);
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || hash(row.payload_json) !== row.payload_hash
    || pairs[0].id !== row.pair_id || pairs[0].checkpoint !== row.checkpoint
    || aggregate?.pair?.id !== row.pair_id || aggregate?.pair?.checkpoint !== row.checkpoint
    || aggregate.version !== 1 || !aggregate.values || typeof aggregate.values !== 'object' || Array.isArray(aggregate.values)) throw Error('PAIR_AUTHORITY_INVALID');
  const deltaClock = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='isolated_plugin_delta_clock'").get()
    && db.prepare('SELECT * FROM isolated_plugin_delta_clock WHERE id=1').get();
  if (!deltaClock) return { aggregate, revision: row.revision, pairId: row.pair_id, checkpoint: row.checkpoint, payloadHash: row.payload_hash };
  if (deltaClock.base_checkpoint !== row.checkpoint || deltaClock.revision <= row.revision) throw Error('PAIR_DELTA_CLOCK_INVALID');
  for (const item of db.prepare('SELECT * FROM isolated_plugin_deltas ORDER BY plugin_id,key').all()) {
    if (hash(item.payload_json) !== item.payload_hash || !aggregate.values[item.plugin_id]) throw Error('PAIR_DELTA_INVALID');
    aggregate.values[item.plugin_id][item.key] = JSON.parse(item.payload_json);
  }
  aggregate.pair = { id: row.pair_id, checkpoint: deltaClock.checkpoint };
  return { aggregate, revision: deltaClock.revision, pairId: row.pair_id, checkpoint: deltaClock.checkpoint, payloadHash: hash(json(aggregate)) };
}
function verifyProjection(file, state) {
  if (!fs.existsSync(file)) throw Error('PAIR_PROJECTION_MISSING');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('PAIR_PROJECTION_INVALID'); }
  if (hash(json(value)) !== state.payloadHash) throw Error('PAIR_PROJECTION_MISMATCH');
}
function checkBundle(guard, directory, allowPartial = false) {
  const root = guard(directory);
  if (!allowPartial && path.basename(root).includes('.partial-')) throw Error('PAIR_INCOMPLETE_BUNDLE');
  const manifestFile = guard(path.join(root, 'manifest.json'));
  if (!fs.existsSync(manifestFile)) throw Error('PAIR_INCOMPLETE_BUNDLE');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== 2 || manifest.complete !== true || !manifest.files
    || json(Object.keys(manifest.files).sort()) !== json([...FILES].sort())) throw Error('PAIR_MANIFEST_INVALID');
  for (const name of FILES) {
    const file = guard(path.join(root, name));
    if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== manifest.files[name]) throw Error('PAIR_BACKUP_HASH_MISMATCH');
  }
  const db = open(guard(path.join(root, FILES[0])), true);
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('PAIR_SQLITE_INVALID');
    const state = authoritative(db);
    if (state.pairId !== manifest.pairId || state.checkpoint !== manifest.checkpoint || state.revision !== manifest.revision) throw Error('PAIR_MANIFEST_STATE_MISMATCH');
    verifyProjection(guard(path.join(root, FILES[1])), state);
    return manifest;
  } finally { db.close(); }
}

function createCheckpointStore({ isolationRoot, root: directory, point = () => {}, formal = false }) {
  const guard = boundary(isolationRoot, formal), root = guard(directory);
  const databaseFile = guard(path.join(root, FILES[0])), aggregateFile = guard(path.join(root, FILES[1]));
  function load() {
    const db = open(databaseFile, true);
    try { return authoritative(db); } finally { db.close(); }
  }
  function project(state) {
    point('projection:before-write');
    const temporary = guard(aggregateFile + '.tmp-' + randomUUID());
    writeNew(temporary, json(state.aggregate));
    point('projection:before-rename');
    fs.renameSync(temporary, aggregateFile);
  }
  function commit(candidate, { initialize = false, expectedCheckpoint = candidate?.pair?.checkpoint } = {}) {
    if (candidate?.version !== 1 || !candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) throw Error('PAIR_AGGREGATE_INVALID');
    const db = open(databaseFile);
    let state;
    try {
      db.exec('BEGIN IMMEDIATE');
      let previous;
      if (initialize) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('isolated_plugin_state','isolated_pair')").get()) throw Error('PAIR_ALREADY_INITIALIZED');
        db.exec('CREATE TABLE isolated_pair(id TEXT NOT NULL,checkpoint TEXT NOT NULL); CREATE TABLE isolated_plugin_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,pair_id TEXT NOT NULL,checkpoint TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL)');
      } else {
        previous = authoritative(db);
        if (expectedCheckpoint !== previous.checkpoint) throw Error('PAIR_STALE_CHECKPOINT');
      }
      const pair = { id: previous?.pairId ?? randomUUID(), checkpoint: randomUUID() };
      const aggregate = { ...candidate, pair }, payload = json(aggregate), revision = (previous?.revision ?? 0) + 1;
      db.prepare('DELETE FROM isolated_pair').run();
      db.prepare('INSERT INTO isolated_pair(id,checkpoint) VALUES(?,?)').run(pair.id, pair.checkpoint);
      db.prepare('INSERT OR REPLACE INTO isolated_plugin_state(id,revision,pair_id,checkpoint,payload_json,payload_hash) VALUES(1,?,?,?,?,?)')
        .run(revision, pair.id, pair.checkpoint, payload, hash(payload));
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='isolated_plugin_deltas'").get()) {
        db.exec('DELETE FROM isolated_plugin_deltas; DELETE FROM isolated_plugin_delta_clock');
      }
      point('commit:before-commit');
      db.exec('COMMIT');
      state = { aggregate, revision, pairId: pair.id, checkpoint: pair.checkpoint, payloadHash: hash(payload) };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* COMMIT was not reached. */ }
      throw error;
    } finally { db.close(); }
    // Once SQLite committed, projection failure cannot turn success into a false CAS failure.
    try { project(state); } catch (error) { state.projectionError = String(error.message ?? error); }
    return state;
  }
  // Durable key-level commits. The JSON file is a derived checkpoint, refreshed on
  // recovery/backup rather than rewriting every vector for a small queue update.
  function commitKeys(candidate, writes) {
    const db = open(databaseFile);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE IF NOT EXISTS isolated_plugin_deltas(plugin_id TEXT NOT NULL,key TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,PRIMARY KEY(plugin_id,key));
        CREATE TABLE IF NOT EXISTS isolated_plugin_delta_clock(id INTEGER PRIMARY KEY CHECK(id=1),base_checkpoint TEXT NOT NULL,checkpoint TEXT NOT NULL,revision INTEGER NOT NULL)`);
      const base = db.prepare('SELECT pair_id,checkpoint,revision FROM isolated_plugin_state WHERE id=1').get();
      const current = db.prepare('SELECT * FROM isolated_plugin_delta_clock WHERE id=1').get();
      if (!base || current && current.base_checkpoint !== base.checkpoint) throw Error('PAIR_DELTA_CLOCK_INVALID');
      if (candidate?.pair?.id !== base.pair_id || candidate?.pair?.checkpoint !== (current?.checkpoint ?? base.checkpoint)) throw Error('PAIR_STALE_CHECKPOINT');
      const checkpoint = randomUUID(), revision = (current?.revision ?? base.revision) + 1;
      for (const { pluginId, key } of writes) {
        const payload = json(candidate.values[pluginId]?.[key]);
        if (typeof payload !== 'string') throw Error('PAIR_DELTA_VALUE_REQUIRED');
        db.prepare('INSERT OR REPLACE INTO isolated_plugin_deltas VALUES(?,?,?,?)').run(pluginId,key,payload,hash(payload));
      }
      db.prepare('INSERT OR REPLACE INTO isolated_plugin_delta_clock VALUES(1,?,?,?)').run(base.checkpoint,checkpoint,revision);
      point('commit:before-commit'); db.exec('COMMIT');
      return { aggregate: { ...candidate, pair: { id: base.pair_id, checkpoint } }, revision, checkpoint };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { db.close(); }
  }
  async function backup(destination) {
    const target = guard(destination);
    if (fs.existsSync(target) || target.startsWith(root + path.sep) || path.basename(target).includes('.partial-')) throw Error('PAIR_BACKUP_TARGET_INVALID');
    const stage = guard(target + '.partial-' + randomUUID());
    fs.mkdirSync(stage);
    const db = open(databaseFile);
    try { await sqliteBackup(db, guard(path.join(stage, FILES[0]))); } finally { db.close(); }
    point('backup:sqlite');
    const snapshot = open(guard(path.join(stage, FILES[0])), true);
    let state;
    try { state = authoritative(snapshot); } finally { snapshot.close(); }
    writeNew(guard(path.join(stage, FILES[1])), json(state.aggregate));
    point('backup:aggregate');
    const manifest = { version: 2, complete: true, pairId: state.pairId, checkpoint: state.checkpoint, revision: state.revision, createdAt: new Date().toISOString(), files: {} };
    for (const name of FILES) {
      const file = guard(path.join(stage, name)), fd = fs.openSync(file, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      manifest.files[name] = hash(fs.readFileSync(file));
    }
    writeNew(guard(path.join(stage, 'manifest.json')), json(manifest));
    checkBundle(guard, stage, true);
    point('backup:verified');
    if (fs.existsSync(target)) throw Error('PAIR_BACKUP_TARGET_INVALID');
    fs.renameSync(stage, target);
    return { root: target, ...manifest };
  }
  return {
    initialize: candidate => commit(candidate, { initialize: true }), commit, commitKeys, read: load, load, backup,
    verifyProjection() { const state = load(); verifyProjection(aggregateFile, state); return state; },
    repairProjection() { const state = load(); project(state); return state; },
  };
}
function validateBundle({ isolationRoot, directory }) { return checkBundle(boundary(isolationRoot), directory); }
function restoreBundle({ isolationRoot, source, destination, point = () => {} }) {
  const guard = boundary(isolationRoot), target = guard(destination), src = guard(source);
  if (fs.existsSync(target) || path.basename(target).includes('.partial-')) throw Error('PAIR_RESTORE_TARGET_EXISTS');
  const manifest = checkBundle(guard, src), stage = guard(target + '.partial-' + randomUUID());
  fs.mkdirSync(stage);
  for (const name of FILES) {
    const bytes = fs.readFileSync(guard(path.join(src, name)));
    if (hash(bytes) !== manifest.files[name]) throw Error('PAIR_BACKUP_CHANGED_DURING_RESTORE');
    writeNew(guard(path.join(stage, name)), bytes);
    point('restore:' + name);
  }
  writeNew(guard(path.join(stage, 'manifest.json')), json(manifest));
  checkBundle(guard, stage, true);
  point('restore:verified');
  if (fs.existsSync(target)) throw Error('PAIR_RESTORE_TARGET_EXISTS');
  fs.renameSync(stage, target);
  return { root: target, ...manifest };
}
module.exports = { createCheckpointStore, validateBundle, restoreBundle };
