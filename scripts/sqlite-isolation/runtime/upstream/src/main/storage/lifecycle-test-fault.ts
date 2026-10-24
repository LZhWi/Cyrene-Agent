// Isolated harness only: pause at a durability boundary so the test can kill the worker.
import { workerData } from 'node:worker_threads';
let command='';
export function setLifecycleTestCommand(method:string){command=method;}
export function lifecycleTestPoint(point:'before-commit'|'after-commit'){
  const fault=workerData?.lifecycleTestFault;
  if(fault?.method!==command||fault.point!==point||!(fault.signal instanceof SharedArrayBuffer))return;
  const signal=new Int32Array(fault.signal);
  Atomics.store(signal,0,1);
  Atomics.wait(signal,0,1);
}
