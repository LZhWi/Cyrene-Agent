import {expect,it,vi,beforeEach} from "vitest";
const mocks=vi.hoisted(()=>({sticker:vi.fn(),scene:vi.fn(),add:vi.fn()}));
vi.mock("../logger",()=>({logger:{info:()=>{}},LogTag:{}}));
vi.mock("../rag/embedding",()=>({getEmbeddingProvider:()=>({}),getSceneEmbeddingProvider:()=>({})}));
vi.mock("../sticker-descriptions",()=>({BUILT_IN_STICKER_DESCRIPTIONS:{}}));
vi.mock("../sticker-embedding-cache",()=>({buildCachedStickerEmbeddingIndex:mocks.sticker}));
vi.mock("../scene-embedding-cache",()=>({buildCachedSceneIndex:mocks.scene}));
vi.mock("../sticker-storage",()=>({loadUserStickerManifest:()=>[]}));
vi.mock("../rag",()=>({addMemory:mocks.add}));
vi.mock("../orchestrator/tools/registry/tool-registry",()=>({toolRegistry:{}}));
vi.mock("../orchestrator/tools/built-in-tools",()=>({currentUserTimezone:()=>"UTC"}));
vi.mock("../locale-context",()=>({getDateLocale:()=>"en"}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});
it("waits for sticker and scene builders and preserves their outputs",async()=>{
 let sticker!:(v:any)=>void,scene!:(v:any)=>void;
 mocks.sticker.mockImplementationOnce(()=>new Promise(r=>{sticker=r;}));mocks.scene.mockImplementationOnce(()=>new Promise(r=>{scene=r;}));
 const {createEmbeddingIndexService}=await import("../services/embedding/embedding-index-service");const tracker=await import("./background-index-work");
 const service=createEmbeddingIndexService();service.refreshStickerEmbeddingIndex("test");service.refreshSceneEmbeddingIndex("test");
 let done=false;const drain=tracker.drainBackgroundIndexes(new AbortController().signal).then(()=>{done=true;});
 sticker([]);await Promise.resolve();expect(done).toBe(false);const result={scenes:{}};scene(result);await drain;
 expect(service.getSceneEmbeddingIndex()).toBe(result);expect(service.getStickerEmbeddingIndex()).toEqual([]);
});
it("startup refresh disposer prevents future builders",async()=>{
 vi.useFakeTimers();try{const {createEmbeddingIndexService}=await import("../services/embedding/embedding-index-service");const disposer=createEmbeddingIndexService().scheduleStartupRefreshes(100);disposer.dispose();await vi.advanceTimersByTimeAsync(101);expect(mocks.sticker).not.toHaveBeenCalled();expect(mocks.scene).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
});
it("history drain includes both user and assistant writes with unchanged text",async()=>{
 let release!:()=>void;mocks.add.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;})).mockResolvedValue(undefined);
 const {indexConversationTurn}=await import("../orchestrator/tools/history-tools");const tracker=await import("./background-index-work");
 const job=indexConversationTurn("s","user-original","assistant-original");let done=false;
 const drain=tracker.drainBackgroundIndexes(new AbortController().signal).then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);release();await Promise.all([job,drain]);
 expect(mocks.add.mock.calls.map(c=>c[0])).toEqual(["user-original","assistant-original"]);
});
