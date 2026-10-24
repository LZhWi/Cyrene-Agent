const {createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bindPrivateTurn(chatState,turn){
 if(turn?.origin!=='companion-chat')throw Error('PRIVATE_SOURCE_ORIGIN_REQUIRED');
 const messages=chatState?.sessions?.find(s=>s.id===turn.sessionId)?.messages;
 const index=messages?.findIndex(m=>m.id===turn.id&&m.role==='user')??-1;
 const user=index>=0?messages[index]:null,assistant=index>=0?messages[index+1]:null;
 if(!user||!assistant||assistant.role!=='assistant'||[user,assistant].some(m=>m.status&&m.status!=='complete')
  ||user.text!==turn.user||assistant.text!==turn.assistant||user.at!==turn.userAt||assistant.at!==turn.assistantAt)throw Error('PRIVATE_SOURCE_MISMATCH');
 const source={conversationId:'private:companion-chat:'+turn.sessionId,userTurnId:user.id,
  userEntryId:'private-user:'+hash([user.id,user.text,user.at]),assistantEntryId:'private-assistant:'+hash([assistant.id,assistant.text,assistant.at])};
 return {...turn,inputMessageId:user.id,finalMessageId:assistant.id,hostSourceVersion:source};
}
module.exports={bindPrivateTurn};
