// Only public enrollment hashes are written. Atomic revisions also invalidate
// suspended windows that miss a BroadcastChannel lock notification.
export function credentialStore(indexedDB){
  function run(write,operation){return new Promise((resolve,reject)=>{
    if(!indexedDB){reject(new Error('Device storage is unavailable.'));return;}
    let abandoned=false;const open=indexedDB.open('darcy-login-v3',1);
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
export async function clearLegacyLogin(indexedDB){
  if(!indexedDB)return;
  for(const name of ['darcy-device-login','darcy-passkey','darcy-passkey-session'])await new Promise((resolve,reject)=>{
    const request=indexedDB.deleteDatabase(name);request.onsuccess=()=>resolve();request.onerror=request.onblocked=()=>reject(new Error('Close old Darcy windows to remove obsolete login data.'));
  });
}
export const BACKGROUND_LOCK_MS=15*60*1000;
export function loginController({store,vault,connect,enroll,checkInvite,disconnect,policy,onConnecting,onConnected,onDisconnected,onPhase,onError,notify=()=>{},visible=()=>true,now=Date.now,later=setTimeout,cancel=clearTimeout}){
  let generation=0,phase='loading',saved={revision:0,record:null},memory=null,pending=null,busy=false,active=false,hiddenAt=null,timer=null,abort=null,retryDelay=1000,inviteCode='';
  const show=p=>{phase=p;onPhase(p);};
  const clearTimer=()=>{if(timer!==null)cancel(timer);timer=null;};
  function reset(){generation++;clearTimer();abort?.abort();abort=null;busy=false;active=false;memory=null;pending=null;inviteCode='';hiddenAt=null;disconnect();onDisconnected();}
  const expired=()=>hiddenAt!==null&&(now()-hiddenAt>=BACKGROUND_LOCK_MS||now()<hiddenAt);
  function expiryTimer(){clearTimer();timer=later(()=>{timer=null;reset();return init();},Math.max(0,BACKGROUND_LOCK_MS-(now()-hiddenAt)));}
  function valid(epoch){if(epoch!==generation)return false;if(expired()){reset();void init();return false;}return true;}
  async function init(){const epoch=generation;try{await vault.ready?.();const value=await store.read();if(!valid(epoch))return;saved=value;show(value.record?.registered?'unlock':'invite');}catch(e){if(epoch===generation){show('invite');onError(e);}}}
  async function current(epoch,revision){const value=await store.read();if(!valid(epoch))return false;if(value.revision!==revision){reset();saved=value;show('unlock');return false;}return true;}
  function retry(){clearTimer();if(!memory||!visible())return;timer=later(()=>{timer=null;return resume();},retryDelay);retryDelay=Math.min(30000,retryDelay*2);}
  async function establish(token,revision,epoch,setup=false){
    onConnecting();show('connecting');active=false;
    const result=await (setup?enroll({...policy,token},inviteCode):connect({...policy,token}));
    if(!valid(epoch))return;
    if(!result.verification)throw new Error('Workspace verification did not pass.');
    if(!await current(epoch,revision))return;
    if(!saved.record?.registered){const value=await store.replace({registered:true},revision);if(!valid(epoch))return;saved=value;revision=value.revision;}
    memory={token,revision};retryDelay=1000;
    if(!visible()){hiddenAt??=now();expiryTimer();disconnect();onDisconnected();show('unlock');return;}
    clearTimer();active=true;hiddenAt=null;inviteCode='';onConnected(result,policy);show('connected');
  }
  function report(e){onError(Object.assign(new Error(e.name==='NotAllowedError'?'Passkey request cancelled. Try again when ready.':e.message||e.error||'Could not unlock.'),{uncertainAction:e.uncertainAction}));}
  async function advance(){
    if(busy)return;const step=phase;if(!['create','secure','confirm','unlock'].includes(step))return;
    const epoch=generation;busy=true;abort=new AbortController();show('working');
    try{
      if(step==='create'){
        const result=await vault.create(abort.signal);if(!valid(epoch))return;
        pending={ownerHash:result.ownerHash,revision:saved.revision};show(result.ownerHash?'confirm':'secure');
      }else{
        const result=await vault.unlock(abort.signal);if(!valid(epoch))return;
        if(step==='secure'){pending={ownerHash:result.ownerHash,revision:saved.revision};show('confirm');}
        else if(step==='confirm'){
          if(result.ownerHash!==pending.ownerHash)throw new Error('Choose the same passkey to confirm setup.');
          memory={token:result.token,revision:saved.revision};
          await establish(result.token,saved.revision,epoch,true);if(!valid(epoch))return;
          pending=null;
        }else{
          if(!await current(epoch,saved.revision))return;
          memory={token:result.token,revision:saved.revision};await establish(result.token,saved.revision,epoch);
        }
      }
    }catch(e){if(epoch===generation){disconnect();onDisconnected();active=false;show(memory?'unlock':step);report(e);}}
    finally{if(epoch===generation){busy=false;abort=null;if(visible()&&(pending||active)){clearTimer();hiddenAt=null;}}}
  }
  async function resume(){
    if(!visible())return;
    if(expired()){reset();await init();return;}
    if(busy||active)return;
    if(pending||inviteCode){clearTimer();hiddenAt=null;return;}
    if(!memory){if(phase==='loading')await init();return;}
    clearTimer();const epoch=generation;busy=true;
    try{if(await current(epoch,memory.revision))await establish(memory.token,memory.revision,epoch);}
    catch(e){if(epoch===generation){disconnect();active=false;show('unlock');report(e);retry();}}
    finally{if(epoch===generation)busy=false;}
  }
  return{
    init,advance,resume,
    async admit(code){if(busy)return;const epoch=generation;busy=true;show('checking');try{const result=await checkInvite(code);if(result?.allowed!==true)throw new Error("Invite required");if(!valid(epoch))return;inviteCode=code;show('create');}catch(e){if(valid(epoch)){show('invite');report(e);}}finally{if(epoch===generation)busy=false;}},
    useExisting(){if(busy)return;show(inviteCode?'secure':'unlock');},
    startSetup(){reset();show('invite');},
    suspend(){
      // A system passkey sheet can hide the page. Do not cancel that ceremony.
      clearTimer();if(!memory&&!pending&&!busy&&!inviteCode)return;
      hiddenAt??=now();expiryTimer();
      if(busy&&!active)return;
      if(!memory)return;
      generation++;busy=false;active=false;disconnect();onDisconnected();show('unlock');
    },
    lost(error){if(!active&&!busy)return;generation++;clearTimer();busy=false;active=false;pending=null;inviteCode='';disconnect();onDisconnected();report(error);show('unlock');if(error.authorizationFailed){memory=null;}else retry();},
    async lock(){reset();const epoch=generation;busy=true;show('loading');notify();try{const value=await store.lock();notify();if(!valid(epoch))return;saved=value;busy=false;await init();}catch(e){if(valid(epoch)){busy=false;show('unlock');report(e);}}},
    async forget(){reset();const epoch=generation;busy=true;show('loading');notify();try{const value=await store.forget();notify();if(!valid(epoch))return;saved=value;busy=false;await init();}catch(e){if(valid(epoch)){busy=false;show('unlock');report(e);}}},
    externalLock(){reset();void init();},
  };
}
