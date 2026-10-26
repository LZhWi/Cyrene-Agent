import { ConversationDatabase } from '../sqlite-isolation/runtime/upstream/src/main/storage/conversation-database';
import { serviceStateCommand } from '../sqlite-isolation/runtime/upstream/src/main/storage/life-service-state';
import { harnessCommand, initializeLifeHarness } from '../sqlite-isolation/runtime/upstream/src/main/storage/life-harness-store';
/** Explicit, real SQLite fixture. Never opens a user profile. */
export function sqliteFixture(root: string) {
 const database=new ConversationDatabase(root);
 initializeLifeHarness(database);
 const call=(method:string,...args:any[])=>method.startsWith('harness.')?harnessCommand(database,method,args):serviceStateCommand(database,method,args);
 for(const [name,value]of Object.entries({tasks:{},usage:{state:{schemaVersion:2,days:{}}},moments:{state:{schemaVersion:2,posts:[],comments:[],reactions:[]}},'channel-history':{},'channel-delivery':{}}))call('services.seed',name,value);
 for(const [name,value]of Object.entries({scheduler:{tasks:{tasks:[]},history:[]},'moments-policy':{state:{}},'moments-reactions':{state:{tasks:[]}}}))call('services.seed',name,value);
 for(const [name,value]of Object.entries({'native-call-context':{state:[]},'native-social':{state:{schemaVersion:1,atoms:[]}},'native-relationship':{state:{entries:[],dailySummaries:[]}},'native-proactive':{state:{}}}))call('services.seed',name,value);
 return {database,call,close:()=>database.close(),provider:(selected:string,namespace:string)=>{
  if(selected!==root)throw Error('TEST_PROFILE_MISMATCH');
  return {get:(key:string)=>call('services.get',namespace,key),set:(key:string,value:any)=>call('services.set',namespace,key,value),all:()=>call('services.all',namespace),call};
 }};
}
