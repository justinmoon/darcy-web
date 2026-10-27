import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {SecureClient} from 'tinfoil';
import {KeyConfigMismatchError} from 'ehbp';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const options={enclaveURL:'http://localhost:8080',configRepo:'owner/config',token:'a'.repeat(64),allowLocalDev:true};
async function fixture(fetch){
  const context=vm.createContext({URL,Error,Set,Object,JSON,Uint8Array,TextDecoder,crypto:webcrypto,AbortSignal,fetch,setTimeout:()=>1,clearTimeout:()=>{}});
  const sdk=new vm.SyntheticModule(['SecureClient'],function(){this.setExport('SecureClient',SecureClient);},{context});
  const config=new vm.SyntheticModule(['default'],function(){this.setExport('default',{});},{context});
  const source=await readFile(new URL('./transport.js',import.meta.url),'utf8');
  const module=new vm.SourceTextModule(source+'\nexport {PinnedClient};',{context});
  await module.link(name=>name==='tinfoil'?sdk:config);await module.evaluate();return module.namespace;
}

test('old connect completion cannot disconnect a new connection',async()=>{
  const first=deferred();let calls=0;
  const api=await fixture(()=>++calls===1?first.promise:Promise.resolve(response({tag:'new'})));
  const old=api.connect(options);await new Promise(setImmediate);
  await api.connect(options);first.resolve(response({tag:'old'}));await assert.rejects(old);
  assert.equal((await api.request('state')).tag,'new');api.disconnect();
});

test('old mutation refresh cannot publish into a new connection',async()=>{
  const refresh=deferred();let calls=0;const seen=[];
  const api=await fixture(()=>++calls===3?refresh.promise:Promise.resolve(response({tag:calls===1?'old':'new'})));
  api.subscribe(value=>seen.push(value));await api.connect(options);
  const old=api.request('import_file');await new Promise(setImmediate);await api.connect(options);
  refresh.resolve(response({tag:'old'}));await assert.rejects(old);
  assert.equal(seen.some(value=>value.data?.tag==='old'),false);
  assert.equal((await api.request('state')).tag,'new');api.disconnect();
});

test('private requests refuse redirects',async()=>{
  let init;const api=await fixture((_,value)=>{init=value;return Promise.resolve(response({}));});
  await api.connect(options);assert.equal(init.redirect,'error');api.disconnect();
});

test('Stop binds the task and mutation requests carry fresh IDs',async()=>{
  const sent=[];const task='b'.repeat(32);
  const api=await fixture((_,init)=>{sent.push(JSON.parse(init.body));return Promise.resolve(response({active_task:task}));});
  await api.connect(options);await api.request('stop');await api.request('import_file');await api.request('send',{text:'test'});
  assert.equal(sent.find(value=>value.action==='stop').task_id,task);
  const ids=sent.filter(value=>['send','import_file'].includes(value.action)).map(value=>value.request_id);
  assert.equal(ids.length,2);assert(ids.every(id=>/^[a-f0-9]{32}$/.test(id)));assert.notEqual(ids[0],ids[1]);api.disconnect();
});

test('oversized response cancels its stream before buffering the rest',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  const api=await fixture(()=>Promise.resolve(new Response(body,{status:500})));
  await assert.rejects(api.connect(options));assert.equal(cancelled,true);api.disconnect();
});

test('real SDK key-mismatch recovery cannot replay a request',async()=>{
  const api=await fixture(()=>{throw new Error('Unexpected network call');});
  const client=new api.PinnedClient({enclaveURL:'https://example.test',configRepo:'owner/config'});
  client.ready=async()=>{};
  let calls=0;
  client._transport={fetch:async()=>{calls++;throw new KeyConfigMismatchError('synthetic mismatch');}};
  await assert.rejects(client.fetch('/api',{method:'POST',body:'private'}),/Reconnect/);
  assert.equal(calls,1);
});
