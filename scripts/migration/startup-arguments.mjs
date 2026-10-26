import path from 'node:path';

export function migrationStartupArguments(args) {
  if(args.includes("--rollback-sqlite"))throw Error("SQLITE_JSON_ROLLBACK_RETIRED: use --restore-sqlite");
  const snapshots=args.filter(arg=>arg.startsWith('--snapshot-sqlite=')||arg.startsWith('--restore-sqlite=')||arg.startsWith('--retire-legacy-json='));
  if(snapshots.length){
    if(snapshots.length!==1||args.some(arg=>['--enable-sqlite','--rollback-sqlite','--rollback-chat-migration'].includes(arg)||arg.startsWith('--import-chat-package=')))throw Error('Choose one storage operation');
    const equal=snapshots[0].indexOf('='),value=snapshots[0].slice(equal+1);
    if(!value.trim())throw Error('Snapshot path is required');
    return [snapshots[0].slice(0,equal+1)+path.resolve(value)];
  }
  const sqlite=args.filter(arg=>arg==='--enable-sqlite'||arg==='--rollback-sqlite');
  if(sqlite.length){if(sqlite.length!==1||args.some(arg=>arg.startsWith('--import-chat-package=')||arg==='--rollback-chat-migration'))throw Error('Choose one migration operation');return sqlite;}
  const imports=args.filter(arg=>arg.startsWith('--import-chat-package='));
  const rollbacks=args.filter(arg=>arg==='--rollback-chat-migration');
  if(imports.length>1||rollbacks.length>1||(imports.length&&rollbacks.length))throw Error('Choose one migration operation');
  if(imports.length){const value=imports[0].slice('--import-chat-package='.length);if(!value.trim())throw Error('Migration package path is required');return ['--import-chat-package='+path.resolve(value)];}
  return rollbacks;
}
