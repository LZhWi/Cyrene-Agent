import { app } from 'electron';
import { createHash } from 'node:crypto';
import { getServiceState } from '../storage/service-state';
import type { IncomingMessage } from './types';
import type { ChannelContext } from './channel-context';
import {prepareChannelHistory} from './history-log';
import { appendLog } from './message-log';

function receiptStore() {
  return getServiceState(app.getPath('userData'),'channel-delivery');
}

export function hasDurableChannelReceipts(): boolean { return Boolean(receiptStore()); }

async function commitReceipt(state:NonNullable<ReturnType<typeof receiptStore>>,key:string,context:ChannelContext){
  const saved=state.get(key);if(saved?.status==='committed')return;
  if(saved?.status!=='delivered')throw Error('CHANNEL_DELIVERY_NOT_CONFIRMED');
  if('call' in state&&typeof state.call==='function'){
    prepareChannelHistory();
    const conversationId=state.call('services.deliveryCommit','channel-delivery',key);
    try{context.onJournalCommitted?.(conversationId);}catch(error){console.warn('[ChannelReceipt] 界面刷新失败:',error);}
    return;
  }
  throw Error('SQLITE_SERVICE_UNAVAILABLE:channel-delivery');
}

/** Complete only known deliveries, before adapters accept new messages. Never send again. */
export async function recoverDeliveredChannelReceipts(context: ChannelContext, signal?: AbortSignal) {
  const state=receiptStore();if(!state)return;
  for(const [key, value] of Object.entries(state.all())) {
    if(signal?.aborted)return;
    const saved=value as any;
    if(['sending','failed'].includes(saved.status)) {
      appendLog({dir:'error',channel:saved.incoming?.channel??'',senderId:saved.incoming?.senderId??'',chatId:saved.incoming?.chatId??'',text:'[发送回执待核对] 上次发送结果未确认，不自动重发。'});
      continue;
    }
    if(saved.status!=='delivered')continue;
    try {
      await commitReceipt(state,key,context);
    } catch(error) {
      console.warn('[ChannelReceipt] 已送达历史恢复失败，保留回执:',key,error);
      appendLog({dir:'error',channel:saved.incoming?.channel??'',senderId:saved.incoming?.senderId??'',chatId:saved.incoming?.chatId??'',text:'[已送达，历史待恢复] 回执已保留，下次启动重试历史提交，不重新发送。'});
    }
  }
}

export function channelReceipt(msg: IncomingMessage) {
  if(!msg.messageId)return undefined;
  const state=receiptStore();if(!state)return undefined;
  const key=createHash('sha256').update(JSON.stringify([msg.channel,msg.chatId,msg.messageId])).digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify([msg.senderId,msg.text,msg.attachments])).digest('hex');
  const saved=state.get(key);if(saved&&saved.fingerprint!==fingerprint)throw Error('CHANNEL_MESSAGE_ID_CONFLICT');
  const incoming={channel:msg.channel,chatId:msg.chatId,senderId:msg.senderId,senderName:msg.senderName,chatType:msg.chatType,messageId:msg.messageId,text:'',at:msg.at.toISOString()};
  return {saved,commit:(context:ChannelContext)=>commitReceipt(state,key,context),write:(value:Record<string,unknown>)=>state.set(key,{...value,incoming,fingerprint,at:Date.now()})};
}
