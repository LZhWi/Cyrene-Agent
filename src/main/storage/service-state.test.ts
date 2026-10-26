import {expect,it,vi} from 'vitest';
it('missing provider or profile backend fails closed',async()=>{
 vi.resetModules();const store=await import('./service-state');expect(()=>store.getServiceState('unconfigured','usage')).toThrow('SQLITE_SERVICE_UNAVAILABLE');
 store.setServiceStateProvider(()=>undefined);expect(()=>store.getServiceState('other-profile','tasks')).toThrow('SQLITE_SERVICE_UNAVAILABLE');
});
