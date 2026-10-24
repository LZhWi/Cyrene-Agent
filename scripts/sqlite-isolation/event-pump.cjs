// Isolation-only automatic outbox consumer. No model, ranking or settings policy.
module.exports = function createEventPump({call, publish, settle, report = () => {}, pollMs = 5000, retryMs = 1000, maxRetryMs = 30000}) {
 let timer, running, stopping = false, failures = 0;
 const state = {phase:'idle', attempts:0, delivered:0, failures:0};
 const notify=()=>{try{report({...state});}catch{state.diagnosticWriteFailures=(state.diagnosticWriteFailures||0)+1;}};
 function schedule(ms) { if(stopping)return; clearTimeout(timer); timer=setTimeout(()=>{timer=undefined;kick();},ms);timer.unref?.(); }
 async function cycle() {
  state.phase='running';state.attempts++;notify();
  try {
   while (!stopping) {
    const rows=await call('life.pendingEvents');
    if(!rows.length)break;
    for(const row of rows) {
     if (stopping) break;
     await publish(row.event);await settle();
     await call('life.ackEvent',row.id);state.delivered++;
    }
   }
   failures=0;delete state.error;state.phase=stopping?'stopped':'idle';schedule(pollMs);
  } catch(error) {
   failures++;state.failures++;state.phase=stopping?'stopped':'retrying';
   // Error class only: no user message/prompt content in retained diagnostics.
   state.error=error?.name||'Error';schedule(Math.min(maxRetryMs,retryMs*2**Math.min(failures-1,8)));
  } finally {notify();}
 }
 function kick(){if(stopping)return;clearTimeout(timer);if(!running)running=cycle().finally(()=>{running=undefined;});return running;}
 return {start:kick,wake:kick,status:()=>({...state}),async stop(){stopping=true;clearTimeout(timer);await running;state.phase='stopped';notify();}};
};
