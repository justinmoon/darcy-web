import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {credentialStore,clearLegacyLogin,loginController,BACKGROUND_LOCK_MS} from './login.js';
const token='a'.repeat(64),policy={enclaveURL:'https://workspace.example',configRepo:'owner/config'};
const options={...policy,token},record={ciphertext:'encrypted-only'};
const verified={verification:true,snapshot:{verified:true,busy:false}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture({db=new IDBFactory(),store=credentialStore(db),vault={validate:()=>{},create:async()=>record,seal:async()=>record,open:async()=>token},connect=async()=>verified,notify=()=>{}}={}){
  const events=[],timers=new Map();let clock=0,id=0,visible=true,phase;
  const c=loginController({store,vault,connect:async args=>{events.push(['connect',args]);return connect(args);},disconnect:()=>events.push(['disconnect']),policy,onConnecting:()=>events.push(['connecting']),onConnected:r=>events.push(['connected',r]),onDisconnected:()=>events.push(['disconnected']),onPhase:p=>{phase=p;},onError:e=>events.push(['error',e.message]),notify,visible:()=>visible,now:()=>clock,later:(f,ms)=>{timers.set(++id,{f,ms});return id;},cancel:i=>timers.delete(i)});
  return{c,store,db,events,timers,get phase(){return phase;},hide(){visible=false;c.suspend();},async show(){visible=true;await c.resume();},elapse:ms=>{clock+=ms;},async setup(){await c.init();await c.prepare(options);await c.advance();await c.advance();},async tick(){const [i,t]=timers.entries().next().value;timers.delete(i);await t.f();await new Promise(r=>setImmediate(r));}};
}
test('one-time setup verifies owner before wrapping, confirms decrypt, persists ciphertext only',async()=>{
  const f=fixture();await f.setup();assert.equal(f.phase,'connected');assert.equal((await f.store.read()).record.ciphertext,'encrypted-only');assert(!JSON.stringify(await f.store.read()).includes(token));assert.equal(f.events.filter(e=>e[0]==='connect').length,2);
});
test('fresh app remains locked with no automatic credential prompt/network request',async()=>{
  const f=fixture();await f.setup();const reload=fixture({db:f.db});await reload.c.init();await reload.c.resume();assert.equal(reload.phase,'unlock');assert.equal(reload.events.length,0);await reload.c.advance();assert.equal(reload.phase,'connected');
});
test('brief app switch restores fresh verified state without another passkey or disk write',async()=>{
  let prompts=0;const f=fixture({vault:{validate:()=>{},create:async()=>record,open:async()=>{prompts++;return token;}}});await f.setup();const before=await f.store.read();f.hide();f.elapse(1000);await f.show();assert.equal(f.phase,'connected');assert.equal(prompts,1);assert.deepEqual(await f.store.read(),before);assert.equal(f.timers.size,0);
});
test('15 minutes in background requires passkey again even if timers were frozen',async()=>{
  const f=fixture();await f.setup();f.hide();f.elapse(BACKGROUND_LOCK_MS);await f.show();assert.equal(f.phase,'unlock');const before=f.events.length;await f.c.resume();assert.equal(f.events.length,before);await f.c.advance();assert.equal(f.phase,'connected');
});
test('background timer clears memory without waiting for foreground',async()=>{
  const f=fixture();await f.setup();f.hide();await f.tick();await f.show();assert.equal(f.phase,'unlock');
});
test('network loss retries connect only, never a mutation and never writes credentials',async()=>{
  const f=fixture();await f.setup();const saved=await f.store.read();f.c.lost(new Error('Check history before retrying.'));await f.tick();assert.equal(f.phase,'connected');assert.deepEqual(await f.store.read(),saved);assert(f.events.some(e=>e[0]==='error'&&e[1].includes('Check history')));
});
test('lock in another window invalidates a frozen window; resume cannot re-save or reconnect',async()=>{
  const a=fixture();await a.setup();const b=fixture({db:a.db});await b.c.init();await b.c.advance();b.hide();await a.c.lock();const before=b.events.length;await b.show();assert.equal(b.phase,'unlock');assert.equal(b.events.filter(e=>e[0]==='connect').length,1);assert.equal((await a.store.read()).revision,2);assert(b.events.length>=before);
});
test('forget leaves a revision tombstone and cannot be undone by another window',async()=>{
  const a=fixture();await a.setup();const b=fixture({db:a.db});await b.c.init();await b.c.advance();b.hide();await a.c.forget();await b.show();assert.equal((await a.store.read()).record,null);assert.equal(b.phase,'import');
});
test('atomic compare-and-set rejects stale setup after lock/forget in another store instance',async()=>{
  const db=new IDBFactory(),a=credentialStore(db),b=credentialStore(db);const initial=await a.read();await b.lock();await assert.rejects(a.replace(record,initial.revision),/another window/);assert.equal((await a.read()).record,null);
});
test('late passkey result cannot reopen or persist after lock',async()=>{
  const pending=deferred(),f=fixture({vault:{validate:()=>{},create:()=>pending.promise,open:async()=>token}});await f.c.init();await f.c.prepare(options);const creating=f.c.advance();await f.c.lock();pending.resolve(record);await creating;assert.equal((await f.store.read()).record,null);assert(!f.events.some(e=>e[0]==='connected'));
});
test('late network result after lock cannot open private UI',async()=>{
  const pending=deferred();let calls=0;const f=fixture({connect:()=>++calls===1?verified:pending.promise});await f.c.init();await f.c.prepare(options);await f.c.advance();const confirming=f.c.advance();await new Promise(r=>setTimeout(r,10));await f.c.lock();pending.resolve(verified);await confirming;assert(!f.events.some(e=>e[0]==='connected'));
});
test('wrong key/failed attestation never creates a passkey record',async()=>{
  const f=fixture({connect:async()=>{throw Error('Denied or wrong release');}});await f.c.init();await f.c.prepare(options);assert.equal(f.phase,'import');assert.equal((await f.store.read()).record,null);
});
test('cancelling passkey leaves encrypted record intact and allows retry',async()=>{
  const f=fixture();await f.setup();await f.c.lock();const saved=await f.store.read();let first=true;const g=fixture({db:f.db,vault:{validate:()=>{},open:async()=>{if(first){first=false;throw new DOMException('cancel','NotAllowedError');}return token;}}});await g.c.init();await g.c.advance();assert.equal(g.phase,'unlock');assert.deepEqual(await f.store.read(),saved);await g.c.advance();assert.equal(g.phase,'connected');
});
test('unsupported provider never persists raw key or grants a session',async()=>{
  const f=fixture({vault:{validate:()=>{},create:async()=>{throw Error('PRF unavailable');}}});await f.c.init();await f.c.prepare(options);await f.c.advance();assert.equal(f.phase,'create');assert.equal((await f.store.read()).record,null);assert(!f.events.some(e=>e[0]==='connected'));
});
test('registration without output adds a separate user-triggered secure step',async()=>{
  const f=fixture({vault:{validate:()=>{},create:async()=>({credentialId:'id'}),seal:async()=>record,open:async()=>token}});await f.c.init();await f.c.prepare(options);await f.c.advance();assert.equal(f.phase,'secure');await f.c.advance();assert.equal(f.phase,'confirm');await f.c.advance();assert.equal(f.phase,'connected');
});
test('unstable PRF confirmation cannot overwrite an existing saved key',async()=>{
  const f=fixture({vault:{validate:()=>{},create:async()=>record,open:async()=> 'b'.repeat(64)}});await f.c.init();await f.c.prepare(options);await f.c.advance();await f.c.advance();assert.equal((await f.store.read()).record,null);assert(!f.events.some(e=>e[0]==='connected'));
});
test('legacy raw login database gets deleted, without importing its secret',async()=>{
  const db=new IDBFactory();await new Promise(resolve=>{const r=db.open('darcy-device-login',1);r.onupgradeneeded=()=>r.result.createObjectStore('credentials');r.onsuccess=()=>{const tx=r.result.transaction('credentials','readwrite');tx.objectStore('credentials').put({token},'workspace');tx.oncomplete=()=>{r.result.close();resolve();};};});await clearLegacyLogin(db);assert(!(await db.databases()).some(d=>d.name==='darcy-device-login'));
});
test('unfinished setup expires after 15 minutes, including when background timers were frozen',async()=>{
  const f=fixture();await f.c.init();await f.c.prepare(options);assert.equal(f.phase,'create');f.hide();f.elapse(BACKGROUND_LOCK_MS);await f.show();assert.equal(f.phase,'import');await f.c.advance();assert.equal((await f.store.read()).record,null);
});
test('late passkey ceremony after background deadline cannot save or unlock',async()=>{
  const pending=deferred(),f=fixture({vault:{validate:()=>{},create:()=>pending.promise,open:async()=>token}});await f.c.init();await f.c.prepare(options);const creating=f.c.advance();f.hide();f.elapse(BACKGROUND_LOCK_MS);pending.resolve(record);await creating;await f.c.init();assert.equal(f.phase,'import');assert.equal((await f.store.read()).record,null);
});
test('lock broadcasts after durable commit, closing a concurrent old-revision unlock',async()=>{
  const db=new IDBFactory(),base=credentialStore(db),gate=deferred();let b,notifications=0;
  const a=fixture({db,store:{...base,lock:async()=>{await gate.promise;return base.lock();}},notify:()=>{notifications++;b?.c.externalLock();}});await a.setup();b=fixture({db});await b.c.init();
  const locking=a.c.lock();await b.c.init();await b.c.advance();assert.equal(b.phase,'connected');gate.resolve();await locking;await b.c.init();assert.equal(notifications,2);assert.equal(b.phase,'unlock');assert.equal(b.events.at(-1)[0],'disconnected');
});
test('briefly hidden system passkey sheet does not leave an expiry timer on foreground setup',async()=>{
  const pending=deferred(),f=fixture({vault:{validate:()=>{},create:()=>pending.promise,open:async()=>token}});await f.c.init();await f.c.prepare(options);const creating=f.c.advance();f.hide();await f.show();pending.resolve(record);await creating;assert.equal(f.phase,'confirm');assert.equal(f.timers.size,0);await f.c.advance();assert.equal(f.phase,'connected');assert.equal(f.timers.size,0);
});
