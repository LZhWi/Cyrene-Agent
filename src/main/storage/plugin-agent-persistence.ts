import {app} from 'electron';
import {createHash} from 'node:crypto';
import {requireStorageRuntime} from './storage-backend';
import {ExecutionLedger} from '../orchestrator/execution-ledger';
import type {HarnessCheckpoint} from '../orchestrator/harness/types';
import type {PluginAgentRunResult} from '../../plugins/api';

export function beginPluginAgentRun(pluginId:string,runId:string,contract:unknown){
  if(!app?.getPath)return undefined;
  const fingerprint=createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  const owner=requireStorageRuntime();
  const args=[pluginId,runId,fingerprint],scope='plugin-agent:'+JSON.stringify([pluginId,runId]);
  const saved=owner.call('pluginAgent.begin',...args) as {result?:PluginAgentRunResult};
  return {
    result:saved.result,
    ledger:new ExecutionLedger({
      begin:(id,fp)=>owner.callAsync('tools.begin',scope,id,fp),
      finish:(id,fp,outcome)=>owner.callAsync('tools.finish',scope,id,fp,outcome,true),
    }),
    checkpoint:(checkpoint:HarnessCheckpoint)=>owner.call('pluginAgent.checkpoint',...args,checkpoint),
    complete:(result:PluginAgentRunResult)=>owner.call('pluginAgent.complete',...args,result),
    interrupt:()=>owner.call('pluginAgent.interrupt',...args),
  };
}
