import type { ConversationDatabase } from './conversation-database';
import fs from 'node:fs';
import path from 'node:path';

export const pluginAgentScope=(pluginId:string,runId:string)=>'plugin-agent:'+JSON.stringify([pluginId,runId]);
export function initializePluginAgent(db:ConversationDatabase){
  db.db.exec(`CREATE TABLE IF NOT EXISTS life_plugin_agent_runs(plugin_id TEXT NOT NULL,run_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,status TEXT NOT NULL,checkpoint_json TEXT,result_json TEXT,
    PRIMARY KEY(plugin_id,run_id));
    CREATE TABLE IF NOT EXISTS life_plugin_agent_import(id INTEGER PRIMARY KEY CHECK(id=1));`);
  const file=path.join(db.userDataRoot,'plugin-agent-runs.json');
  if(!db.db.prepare('SELECT 1 FROM life_plugin_agent_import WHERE id=1').get())db.transaction(()=>{
    const rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];if(!Array.isArray(rows))throw Error('PLUGIN_AGENT_IMPORT_INVALID');
    for(const row of rows){
      if(!row.plugin_id||!row.run_id||!row.fingerprint||!['running','interrupted','completed'].includes(row.status))throw Error('PLUGIN_AGENT_IMPORT_INVALID');
      if(row.status==='completed'&&typeof JSON.parse(row.result_json)?.text!=='string')throw Error('PLUGIN_AGENT_IMPORT_INVALID');
      db.db.prepare('INSERT OR IGNORE INTO life_plugin_agent_runs VALUES(?,?,?,?,?,?)').run(row.plugin_id,row.run_id,row.fingerprint,row.status,row.checkpoint_json,row.result_json);
    }
    db.db.prepare('INSERT INTO life_plugin_agent_import VALUES(1)').run();
  });
  db.db.exec("UPDATE life_plugin_agent_runs SET status='interrupted' WHERE status='running'");
}
export function pluginAgentCommand(db:ConversationDatabase,method:string,args:any[]){
  if(method==='pluginAgent.export')return db.db.prepare('SELECT * FROM life_plugin_agent_runs').all();
  const [pluginId,runId,fingerprint,payload]=args;
  if(typeof pluginId!=='string'||!pluginId||typeof runId!=='string'||!runId||typeof fingerprint!=='string'||!fingerprint)throw Error('PLUGIN_AGENT_ID_INVALID');
  const scope=pluginAgentScope(pluginId,runId);
  return db.transaction(()=>{
    const row=db.db.prepare('SELECT * FROM life_plugin_agent_runs WHERE plugin_id=? AND run_id=?').get(pluginId,runId);
    if(row&&row.fingerprint!==fingerprint)throw Error('PLUGIN_AGENT_RUN_ID_CONFLICT');
    if(method==='pluginAgent.begin'){
      if(row){
        if(row.status==='completed')return {result:JSON.parse(row.result_json as string)};
        throw Error(row.status==='running'?'PLUGIN_AGENT_RUN_ACTIVE':'PLUGIN_AGENT_RUN_INTERRUPTED: 上次运行未完整落盘，请核实工具执行结果，禁止自动重跑。');
      }
      db.db.prepare("INSERT INTO life_plugin_agent_runs VALUES(?,?,?,'running',NULL,NULL)").run(pluginId,runId,fingerprint);
      return {};
    }
    if(!row||row.status!=='running')throw Error('PLUGIN_AGENT_RUN_NOT_ACTIVE');
    if(method==='pluginAgent.checkpoint'){
      if(!Array.isArray(payload?.messages)||!payload.state)throw Error('PLUGIN_AGENT_CHECKPOINT_INVALID');
      db.db.prepare('UPDATE life_plugin_agent_runs SET checkpoint_json=? WHERE plugin_id=? AND run_id=?').run(JSON.stringify(payload),pluginId,runId);
      for(const message of payload.messages){
        if(message.role!=='tool'||typeof message.toolCallId!=='string'||typeof message.content!=='string')continue;
        db.db.prepare("UPDATE tool_operations SET status='succeeded' WHERE scope_id=? AND operation_id=? AND status='ready'").run(scope,`${runId}:${message.toolCallId}`);
      }
      return;
    }
    if(method==='pluginAgent.complete'){
      if(db.db.prepare("SELECT 1 FROM tool_operations WHERE scope_id=? AND status IN ('started','ready')").get(scope))throw Error('PLUGIN_AGENT_RESULT_NOT_COMMITTED');
      if(typeof payload?.text!=='string'||!payload.terminal)throw Error('PLUGIN_AGENT_RESULT_INVALID');
      db.db.prepare("UPDATE life_plugin_agent_runs SET status='completed',result_json=? WHERE plugin_id=? AND run_id=?").run(JSON.stringify(payload),pluginId,runId);return;
    }
    if(method==='pluginAgent.interrupt'){
      db.db.prepare("UPDATE life_plugin_agent_runs SET status='interrupted' WHERE plugin_id=? AND run_id=?").run(pluginId,runId);
      db.db.prepare("UPDATE tool_operations SET status='unknown' WHERE scope_id=? AND status IN ('started','ready')").run(scope);return;
    }
    throw Error('PLUGIN_AGENT_COMMAND_INVALID');
  });
}
