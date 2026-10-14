import path from 'node:path';

export function migrationStartupArguments(args) {
  const imports=args.filter(arg=>arg.startsWith('--import-chat-package='));
  const rollbacks=args.filter(arg=>arg==='--rollback-chat-migration');
  if(imports.length>1||rollbacks.length>1||(imports.length&&rollbacks.length))throw Error('Choose one migration operation');
  if(imports.length){const value=imports[0].slice('--import-chat-package='.length);if(!value.trim())throw Error('Migration package path is required');return ['--import-chat-package='+path.resolve(value)];}
  return rollbacks;
}
