// Only encrypted passkey records are written. Atomic revisions also invalidate
// suspended windows that miss a BroadcastChannel lock notification.
export function credentialStore(indexedDB){
  function run(write,operation){return new Promise((resolve,reject)=>{
    if(!indexedDB){reject(new Error('Device storage is unavailable.'));return;}
    let abandoned=false;const open=indexedDB.open('darcy-passkey',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('vault');
    open.onerror=()=>reject(new Error('Device storage is unavailable.'));
    open.onblocked=()=>{abandoned=true;reject(new Error('Close other Darcy windows and try again.'));};
    open.onsuccess=()=>{
      const db=open.result;if(abandoned){db.close();return;}db.onversionchange=()=>db.close();
      const tx=db.transaction('vault',write?'readwrite':'readonly'),s=tx.objectStore('vault');let result,problem;
      tx.oncomplete=()=>{db.close();resolve(result);};tx.onabort=tx.onerror=()=>{db.close();reject(problem||new Error('Could not update this device’s passkey.'));};
      const read=s.get('workspace');read.onsuccess=()=>{try{const current=read.result||{revision:0,record:null};result=operation(current);if(write)s.put(result,'workspace');}catch(e){problem=e;tx.abort();}};
    };
  });}
  return{
    read:()=>run(false,value=>value),
    replace:(record,expected)=>run(true,current=>{if(current.revision!==expected)throw new Error('Login changed in another window. Start again.');return{revision:current.revision+1,record};}),
    lock:()=>run(true,current=>({...current,revision:current.revision+1})),
    forget:()=>run(true,current=>({revision:current.revision+1,record:null})),
  };
}
export function clearLegacyLogin(indexedDB){return new Promise((resolve,reject)=>{
  if(!indexedDB){resolve();return;}const request=indexedDB.deleteDatabase('darcy-device-login');request.onsuccess=()=>resolve();request.onerror=request.onblocked=()=>reject(new Error('Close old Darcy windows to remove obsolete login data.'));
});}
export const BACKGROUND_LOCK_MS=15*60*1000;
export function loginController({store,vault,connect,disconnect,policy,onConnecting,onConnected,onDisconnected,onPhase,onError,notify=()=>{},visible=()=>true,now=Date.now,later=setTimeout,cancel=clearTimeout}){
  let generation=0,phase='loading',saved={revision:0,record:null},memory=null,pending=null,busy=false,active=false,hiddenAt=null,timer=null,abort=null,retryDelay=1000;
  const show=p=>{phase=p;onPhase(p);};
  const clearTimer=()=>{if(timer!==null)cancel(timer);timer=null;};
  function reset(){generation++;clearTimer();abort?.abort();abort=null;busy=false;active=false;memory=null;pending=null;hiddenAt=null;disconnect();onDisconnected();}
  const expired=()=>hiddenAt!==null&&(now()-hiddenAt>=BACKGROUND_LOCK_MS||now()<hiddenAt);
  function expiryTimer(){clearTimer();timer=later(()=>{timer=null;reset();return init();},Math.max(0,BACKGROUND_LOCK_MS-(now()-hiddenAt)));}
  function valid(epoch){if(epoch!==generation)return false;if(expired()){reset();void init();return false;}return true;}
  async function init(){const epoch=generation;try{const value=await store.read();if(!valid(epoch))return;saved=value;if(value.record)vault.validate(value.record);show(value.record?'unlock':'import');}catch(e){if(epoch===generation){show('import');onError(e);}}}
  async function current(epoch,revision){const value=await store.read();if(!valid(epoch))return false;if(value.revision!==revision){reset();saved=value;show(value.record?'unlock':'import');return false;}return true;}
  function retry(){clearTimer();if(!memory||!visible())return;timer=later(()=>{timer=null;return resume();},retryDelay);retryDelay=Math.min(30000,retryDelay*2);}
  async function establish(token,revision,epoch){
    onConnecting();show('connecting');active=false;
    const result=await connect({...policy,token});
    if(!valid(epoch))return;
    if(!result.verification)throw new Error('Workspace verification did not pass.');
    if(!await current(epoch,revision))return;
    memory={token,revision};retryDelay=1000;
    if(!visible()){hiddenAt??=now();expiryTimer();disconnect();onDisconnected();show('unlock');return;}
    clearTimer();active=true;hiddenAt=null;onConnected(result,policy);show('connected');
  }
  function report(e){onError(new Error(e.name==='NotAllowedError'?'Passkey request cancelled. Try again when ready.':e.message||e.error||'Could not unlock.'));}
  async function prepare(options){
    if(busy)return;reset();const epoch=generation;busy=true;onConnecting();show('connecting');
    try{
      saved=await store.read();if(!valid(epoch))return;
      const result=await connect(options);if(!valid(epoch))return;
      if(!result.verification)throw new Error('A verified workspace is required for passkey setup.');
      disconnect();pending={token:options.token,revision:saved.revision,record:null};show('create');
    }catch(e){if(epoch===generation){disconnect();show('import');report(e);}}
    finally{if(epoch===generation)busy=false;}
  }
  async function advance(){
    if(busy)return;const step=phase;if(!['create','secure','confirm','unlock'].includes(step))return;
    const epoch=generation;busy=true;abort=new AbortController();show('working');
    try{
      if(step==='create'){
        const record=await vault.create(pending.token,abort.signal);if(!valid(epoch))return;pending.record=record;show(record.ciphertext?'confirm':'secure');
      }else if(step==='secure'){
        const record=await vault.seal(pending.token,pending.record,abort.signal);if(!valid(epoch))return;pending.record=record;show('confirm');
      }else if(step==='confirm'){
        const token=await vault.open(pending.record,abort.signal);if(!valid(epoch))return;
        if(token!==pending.token)throw new Error('Passkey unlock check failed. Use your recovery key.');
        const value=await store.replace(pending.record,pending.revision);if(!valid(epoch))return;saved=value;pending=null;
        memory={token,revision:value.revision};await establish(token,value.revision,epoch);
      }else{
        const token=await vault.open(saved.record,abort.signal);if(!valid(epoch))return;
        if(!await current(epoch,saved.revision))return;memory={token,revision:saved.revision};await establish(token,saved.revision,epoch);
      }
    }catch(e){if(epoch===generation){disconnect();active=false;show(memory?'unlock':step);report(e);}}
    finally{if(epoch===generation){busy=false;abort=null;if(visible()&&(pending||active)){clearTimer();hiddenAt=null;}}}
  }
  async function resume(){
    if(!visible())return;
    if(expired()){reset();await init();return;}
    if(busy||active)return;
    if(pending){clearTimer();hiddenAt=null;return;}
    if(!memory){if(phase==='loading')await init();return;}
    clearTimer();const epoch=generation;busy=true;
    try{if(await current(epoch,memory.revision))await establish(memory.token,memory.revision,epoch);}
    catch(e){if(epoch===generation){disconnect();active=false;show('unlock');report(e);retry();}}
    finally{if(epoch===generation)busy=false;}
  }
  return{
    init,prepare,advance,resume,
    suspend(){
      // A system passkey sheet can hide the page. Do not cancel that ceremony.
      clearTimer();if(!memory&&!pending&&!busy)return;
      hiddenAt??=now();expiryTimer();
      if(busy&&!active)return;
      if(!memory)return;
      generation++;busy=false;active=false;disconnect();onDisconnected();show('unlock');
    },
    lost(error){if(!active&&!busy)return;generation++;clearTimer();busy=false;active=false;disconnect();onDisconnected();report(error);show(saved.record?'unlock':'import');if(error.authorizationFailed){memory=null;}else retry();},
    async lock(){reset();const epoch=generation;busy=true;show('loading');notify();try{const value=await store.lock();notify();if(!valid(epoch))return;saved=value;busy=false;await init();}catch(e){if(valid(epoch)){busy=false;show(saved.record?'unlock':'import');report(e);}}},
    async forget(){reset();const epoch=generation;busy=true;show('loading');notify();try{const value=await store.forget();notify();if(!valid(epoch))return;saved=value;busy=false;await init();}catch(e){if(valid(epoch)){busy=false;show('unlock');report(e);}}},
    externalLock(){reset();void init();},
  };
}
