import type { ConversationDatabase } from './conversation-database';
import { applyUsageToDay } from '../../../../../../../src/shared/token-usage-counters';
import {compactOperationPayloads,operationDigest} from './life-operation-digest';

export function usageStore(database: ConversationDatabase) {
  const db = database.db;
  db.exec(`CREATE TABLE IF NOT EXISTS life_usage_rows(day TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(day,kind,model));
    CREATE TABLE IF NOT EXISTS life_usage_operations(id TEXT PRIMARY KEY,input_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS life_service_migrations(id TEXT PRIMARY KEY);`);
  compactOperationPayloads(database,'life_usage_operations');
  const put = (day:string,kind:string,model:string,value:any) => db.prepare('INSERT INTO life_usage_rows VALUES(?,?,?,?) ON CONFLICT(day,kind,model) DO UPDATE SET value_json=excluded.value_json').run(day,kind,model,JSON.stringify(value));
  if (!db.prepare("SELECT 1 FROM life_service_migrations WHERE id='usage-rows-v1'").get()) database.transaction(()=>{
    const row=db.prepare("SELECT value_json FROM life_service_state WHERE namespace='usage' AND key='state'").get();
    if(!row)throw Error('USAGE_STATE_MISSING');
    const state=JSON.parse(row.value_json as string);
    for(const [day,value] of Object.entries(state.days??{}) as Array<[string,any]>){
      const {models,...total}=value;put(day,'total','',total);
      if(models!==undefined)put(day,'models-present','',true);
      for(const [model,counters]of Object.entries(models??{}))put(day,'model',model,counters);
    }
    db.prepare("UPDATE life_service_state SET value_json=? WHERE namespace='usage' AND key='state'").run(JSON.stringify({...state,days:{}}));
    db.prepare("INSERT INTO life_service_migrations VALUES('usage-rows-v1')").run();
  });
  const readDay=(day:string):any=>{
    const row=db.prepare("SELECT value_json FROM life_usage_rows WHERE day=? AND kind='total'").get(day);
    if(!row)return undefined;
    const value=JSON.parse(row.value_json as string);
    if(db.prepare("SELECT 1 FROM life_usage_rows WHERE day=? AND kind='models-present'").get(day))value.models={};
    for(const r of db.prepare("SELECT model,value_json FROM life_usage_rows WHERE day=? AND kind='model'").all(day))(value.models??={})[r.model as string]=JSON.parse(r.value_json as string);
    return value;
  };
  return {
    read(){const state=JSON.parse(db.prepare("SELECT value_json FROM life_service_state WHERE namespace='usage' AND key='state'").get()!.value_json as string);for(const r of db.prepare("SELECT day FROM life_usage_rows WHERE kind='total'").all())state.days[r.day as string]=readDay(r.day as string);return state;},
    batch(operations:any[]){return database.transaction(()=>{
      for(const operation of operations){
        const input=operationDigest(JSON.stringify(operation)),old=db.prepare('SELECT input_json FROM life_usage_operations WHERE id=?').get(operation.id);
        if(old){if(old.input_json!==input)throw Error('USAGE_OPERATION_CONFLICT');continue;}
        const day=readDay(operation.day)??{input:0,output:0,hit:0,miss:0,cacheCreation:0,requests:0};
        let model:string;
        if(operation.kind==='usage'){
          const [input,output,requests,cachedInput,name,creation]=operation.args;
          model=name?.trim()||'未归类';applyUsageToDay(day,input,output,requests,cachedInput,model,creation);
        }else if(operation.kind==='request'){
          model=operation.args[0]?.trim()||'未归类';day.attemptedRequests=(day.attemptedRequests??0)+1;
          const entry=(day.models??={})[model]??{input:0,output:0,hit:0,miss:0,cacheCreation:0,requests:0};entry.attemptedRequests=(entry.attemptedRequests??0)+1;day.models[model]=entry;
        }else throw Error('USAGE_OPERATION_INVALID');
        const {models,...total}=day;put(operation.day,'total','',total);put(operation.day,'models-present','',true);put(operation.day,'model',model,models[model]);
        db.prepare('INSERT INTO life_usage_operations VALUES(?,?)').run(operation.id,input);
      }
    });},
    clear(){database.transaction(()=>{db.prepare('DELETE FROM life_usage_rows').run();db.prepare("UPDATE life_service_state SET value_json=? WHERE namespace='usage' AND key='state'").run(JSON.stringify({schemaVersion:2,days:{}}));});},
  };
}
