import {SecureClient} from 'tinfoil';
import deployment from './deployment.json';

export const defaultConnection=Object.freeze({...deployment});
const listeners=new Set();
let session=null,timer=null,generation=0,lastSnapshot=null;
const emit=value=>{for(const listener of listeners)listener(value);};
export function subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}
export function disconnect(){generation++;if(timer)clearTimeout(timer);timer=null;session=null;lastSnapshot=null;}

class PinnedClient extends SecureClient{
  // SDK 1.3.0 retries after an unauthenticated key-mismatch response. The
  // request may already have run. Require a new connection instead of replay.
  reset(){super.reset();throw new Error('Encryption channel changed. Reconnect and inspect history before retrying.');}
  async ready(){
    await super.ready();
    const proof=this.getVerificationDocument();
    if(!proof.securityVerified||!deployment.releaseDigest||proof.releaseDigest!==deployment.releaseDigest)
      throw new Error('The enclave does not match this app’s approved release. No private request was sent.');
  }
}

function loseConnection(error,active=session){
  if(active!==session){const failure=new Error('An earlier connection ended.');failure.reconnectRequired=false;return failure;}
  disconnect();
  const failure=new Error('Connection lost. Reconnect and check recent history before retrying a task.');
  failure.reconnectRequired=true;
  emit({event:'error',error:failure.message,reconnectRequired:true});
  return failure;
}

async function boundedText(response){
  if(!response.body)throw new Error('Missing workspace response.');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let size=0,text='';
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>24*1024*1024){await reader.cancel();throw new Error('Workspace response exceeds the limit.');}
      text+=decoder.decode(value,{stream:true});
    }
    return text+decoder.decode();
  }finally{reader.releaseLock();}
}

async function exchange(active,action,args={}){
  const body=JSON.stringify({...args,action,authToken:active.token});
  let response;
  try{
    response=await active.fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(90000)});
  }catch(error){throw loseConnection(error,active);}
  let value;
  try{
    const text=await boundedText(response);
    value=JSON.parse(text);
  }catch(error){throw loseConnection(error,active);}
  if(!response.ok){
    const error=new Error(value.error||`Workspace request failed (${response.status}).`);
    if(response.status===401||response.status===403){
      if(session===active){disconnect();emit({event:'error',error:error.message,reconnectRequired:true});}
      error.reconnectRequired=true;
    }
    throw error;
  }
  return value;
}

function schedule(active){
  if(timer)clearTimeout(timer);
  timer=setTimeout(async()=>{
    if(session!==active)return;
    try{
      const snapshot=await exchange(active,'state');
      if(session!==active)return;
      lastSnapshot=snapshot;emit({event:'state',data:snapshot});schedule(active);
    }catch(error){if(session===active){disconnect();emit({event:'error',error:error.message,reconnectRequired:true});}}
  },lastSnapshot?.busy?600:2500);
}

export async function connect(options){
  disconnect();const started=generation;
  const url=new URL(options.enclaveURL);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Use only the enclave origin, without a path or credentials.');
  if(typeof options.token!=='string'||options.token.length<32||options.token.length>512)throw new Error('Enter the complete owner access key.');
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  let active,verification=false;
  if(options.allowLocalDev&&loopback&&url.protocol==='http:'){
    active={token:options.token,fetch:(path,init)=>fetch(new URL(path,url),init)};
  }else{
    if(url.protocol!=='https:')throw new Error('A deployed workspace requires HTTPS and attestation.');
    if(!deployment.releaseDigest||options.configRepo!==deployment.configRepo||url.origin!==new URL(deployment.enclaveURL).origin)
      throw new Error('This build has no approved deployment for that workspace. Use its pinned release configuration.');
    const client=new PinnedClient({enclaveURL:url.origin,configRepo:deployment.configRepo,baseURL:url.origin+'/'});
    await client.ready();verification=true;
    active={token:options.token,client,fetch:(path,init)=>client.fetch(path,init)};
  }
  if(started!==generation)throw new Error('Connection was cancelled.');
  session=active;
  try{
    const snapshot=await exchange(active,'state');
    if(session!==active)throw new Error('Connection was cancelled.');
    lastSnapshot=snapshot;schedule(active);
    return{verification,mode:verification?'tee':'dev',snapshot};
  }catch(error){if(session===active)disconnect();throw error;}
}

export async function request(action,args={}){
  const active=session;if(!active)throw new Error('Connect to the workspace first.');
  if(['send','import_file','phone_pair','phone_revoke'].includes(action)){
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    args={...args,request_id:[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')};
  }
  if(action==='stop'){
    if(typeof lastSnapshot?.active_task!=='string')throw new Error('No current task to stop. Refresh the workspace first.');
    args={...args,task_id:lastSnapshot.active_task};
  }
  let result;
  try{result=await exchange(active,action,args);}catch(error){
    if(action==='send'&&!error.reconnectRequired)throw loseConnection(error,active);
    throw error;
  }
  if(session!==active)throw new Error('Connection changed. Reconnect before continuing.');
  if(action==='history')return{...lastSnapshot,...result};
  if(['send','stop','import_file'].includes(action)){
    try{
      const snapshot=await exchange(active,'state');
      if(session!==active)throw new Error('Connection changed.');
      lastSnapshot=snapshot;emit({event:'state',data:snapshot});
    }catch(error){throw loseConnection(error,active);}
  }
  schedule(active);return result;
}
