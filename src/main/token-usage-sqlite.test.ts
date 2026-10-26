import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('electron',()=>({app:{getPath:()=>'/isolated-unused-profile'}}));
describe('SQLite token usage lifecycle',()=>{
  beforeEach(()=>{vi.resetModules();vi.useFakeTimers();});
  afterEach(()=>vi.useRealTimers());
  async function setup(){
    const call=vi.fn();
    const {setServiceStateProvider}=await import('./storage/service-state');
    setServiceStateProvider(()=>({get:()=>({schemaVersion:2,days:{}}),set:vi.fn(),all:()=>({}),call}));
    return {call,usage:await import('./token-usage-store')};
  }
  it('clear before first read reaches SQLite; queued counts cannot reappear',async()=>{
    const {call,usage}=await setup();usage.clearUsage();expect(call).toHaveBeenCalledWith('services.usageClear','usage');
    usage.recordUsage(10,2);usage.clearUsage();usage.flush();
    expect(call.mock.calls.filter(x=>x[0]==='services.usageBatch')).toHaveLength(0);
  });
  it('failed flush retains the same operation ids; failed clear preserves the queue',async()=>{
    const {call,usage}=await setup();usage.recordUsage(10,2);
    call.mockImplementationOnce(()=>{throw Error('unavailable');});expect(()=>usage.flush()).toThrow('unavailable');
    const first=structuredClone(call.mock.calls[0][2]);
    call.mockImplementationOnce(()=>{throw Error('clear failed');});expect(()=>usage.clearUsage()).toThrow('clear failed');
    usage.flush();expect(call.mock.calls.at(-1)?.[2]).toEqual(first);usage.flush();
    expect(call.mock.calls.filter(x=>x[0]==='services.usageBatch')).toHaveLength(2);
  });
});
