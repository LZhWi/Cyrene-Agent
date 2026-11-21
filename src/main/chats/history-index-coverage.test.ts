import {expect,it} from 'vitest';
import {missingHistoryTurns} from './history-index-coverage';
it('detects old holes and wrong source versions regardless of message position',()=>{
 const messages:any[]=[{id:'old',role:'model',content:'old text',at:1},{id:'new',role:'user',content:'new text',at:2}];
 const entries=[{text:'new text',metadata:{occurrences:[{sessionId:'s',turnId:'new',role:'user',ts:2}]}}];
 expect(missingHistoryTurns('s',messages,entries)).toEqual(['old']);
 const valid={text:'old text',metadata:{sessionId:'s',turnId:'old',role:'assistant',ts:1}};
 expect(missingHistoryTurns('s',messages,[...entries,valid])).toEqual([]);
 expect(missingHistoryTurns('s',messages,[...entries,{...valid,metadata:{...valid.metadata,sessionId:'deleted'}}])).toEqual(['old']);
 expect(missingHistoryTurns('s',messages,[...entries,{...valid,metadata:{...valid.metadata,ts:0}}])).toEqual(['old']);
 expect(missingHistoryTurns('s',[],[valid])).toEqual([]);
});
