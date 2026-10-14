import {expect,it,vi} from 'vitest';
vi.mock('../../src/main/sticker-storage',()=>({loadUserStickerManifest:()=>({})}));
import {migrateLegacyHistoryIndex} from '../plugins/companion-memory/src/legacy-history-index';
const session:any={id:'s',messages:[{id:'u',role:'user',content:'你好',at:1},{id:'a',role:'model',content:'<think>隐藏</think>回答',at:2},{id:'pending',role:'user',content:'未完成',at:3}]};
const rows=[{source:'chat_history',text:'你好',embedding:Array(64).fill(.1)},{source:'chat_history',text:'回答',embedding:Array(64).fill(.2)}];
it('按宿主可见正文迁移，忽略末尾未完成消息，重复导入稳定',()=>{const old={version:1 as const,entries:{}};const result=migrateLegacyHistoryIndex([session],rows,old);expect(result.added).toBe(2);expect(result.missing).toEqual([]);expect(Object.keys(old.entries)).toHaveLength(0);expect(result.index.entries['host-message:s:a'].text).toBe('回答');expect(migrateLegacyHistoryIndex([session],rows,result.index).added).toBe(0);});
it('不复用不同正文，不覆盖已有匹配向量',()=>{const old={version:1 as const,entries:{'host-message:s:u':{text:'你好',embedding:Array(64).fill(.5)}}};const result=migrateLegacyHistoryIndex([session],[rows[0],{...rows[1],text:'相似回答'}],old);expect(result.missing).toEqual(['host-message:s:a']);expect(result.index.entries['host-message:s:u']).toEqual(old.entries['host-message:s:u']);});
it('拒绝非法和混合维度的向量',()=>{expect(()=>migrateLegacyHistoryIndex([session],[rows[0],{...rows[1],embedding:[NaN]}],{version:1,entries:{}})).toThrow();expect(()=>migrateLegacyHistoryIndex([session],[rows[0],{...rows[1],embedding:Array(65).fill(.2)}],{version:1,entries:{}})).toThrow();});
