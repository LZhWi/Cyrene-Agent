import {beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
const mocks=vi.hoisted(()=>({runtime:vi.fn(),exists:vi.fn(),read:vi.fn()}));
vi.mock('electron',()=>({app:{getPath:()=>'/isolated-profile'}}));
vi.mock('./storage-backend',()=>({requireStorageRuntime:mocks.runtime}));
vi.mock('node:fs',()=>({default:{existsSync:mocks.exists,readFileSync:mocks.read}}));
import {beginPluginAgentRun} from './plugin-agent-persistence';
beforeEach(()=>vi.resetAllMocks());
it('storage selection failure is not replaced by an in-memory ledger',()=>{
  mocks.runtime.mockImplementation(()=>{throw Error('SQLITE_SELECTION_MISSING');});
  expect(()=>beginPluginAgentRun('p','r',{})).toThrow('SQLITE_SELECTION_MISSING');
});
it('does not read legacy results when SQLite is unavailable',()=>{
  mocks.runtime.mockImplementation(()=>{throw Error('SQLITE_NOT_INITIALIZED');});
  mocks.exists.mockReturnValue(true);expect(()=>beginPluginAgentRun('p','r',{})).toThrow('SQLITE_NOT_INITIALIZED');expect(mocks.read).not.toHaveBeenCalled();
});
it('plugin namespace is part of the tool ledger scope and finish remains ready',async()=>{
  const call=vi.fn(()=>({})),callAsync=vi.fn(async()=>null);mocks.runtime.mockReturnValue({call,callAsync});
  const p=beginPluginAgentRun('p','r',{})!;
  await p.ledger!.execute({logicalInvocationId:'r:t',capability:'p_tool',targetRefs:[],args:{}},async()=>({status:'succeeded',output:'done'}));
  expect(callAsync.mock.calls[0][1]).toBe('plugin-agent:["p","r"]');
  expect(callAsync.mock.calls.at(-1)?.at(-1)).toBe(true);
});
