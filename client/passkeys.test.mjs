import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto as crypto} from 'node:crypto';
import {passkeys} from './passkeys.js';
const policy={enclaveURL:'https://workspace.example',configRepo:'owner/config'},identity={crypto,policy,origin:'https://app.example',scope:'/darcy-web/'};
async function fixture({output=true,array=false,enabled=true,changing=false,zero=false}={}){
  const calls=[];let count=0;const first=()=>{const b=new Uint8Array(32).fill(zero?0:changing?++count:7);return array?[...b]:b.buffer;};
  const credentials={async create(args){calls.push(['create',args]);return{type:'public-key',getClientExtensionResults:()=>({prf:enabled?{enabled:true,...(output?{results:{first:first()}}:{})}:{}})};},async get(args){calls.push(['get',args]);return{type:'public-key',getClientExtensionResults:()=>({prf:{results:{first:first()}}})};}};
  const vault=passkeys({...identity,credentials});await vault.ready();return{credentials,calls,vault};
}
test('passkey derives stable capability and public enrollment hash; registration exposes no token',async()=>{
  const f=await fixture(),registration=await f.vault.create(),a=await f.vault.unlock(),b=await f.vault.unlock();assert.deepEqual(a,b);assert.equal(a.ownerHash,registration.ownerHash);assert.match(a.token,/^[a-f0-9]{64}$/);assert.notEqual(a.token,a.ownerHash);assert.deepEqual(Object.keys(registration),['ownerHash']);
  assert.equal(a.ownerHash,Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(a.token))).toString('hex'));
});
test('fresh browser discovers synced passkey without local metadata or file',async()=>{
  const f=await fixture();await f.vault.unlock();const request=f.calls[0][1].publicKey;assert.equal(request.allowCredentials,undefined);assert.equal(request.userVerification,'required');assert.equal(request.rpId,'app.example');
});
test('registration leaves provider choice to user; fresh challenges and mandatory verification',async()=>{
  const f=await fixture();await f.vault.create();await f.vault.unlock();assert.equal(f.calls[0][1].publicKey.authenticatorSelection.authenticatorAttachment,undefined);assert.equal(f.calls[0][1].publicKey.authenticatorSelection.residentKey,'required');assert.equal(f.calls[0][1].publicKey.authenticatorSelection.userVerification,'required');assert.notDeepEqual(f.calls[0][1].publicKey.challenge,f.calls[1][1].publicKey.challenge);
});
test('Safari registration without output requires explicit later evaluation',async()=>{const f=await fixture({output:false});assert.deepEqual(await f.vault.create(),{ownerHash:null});assert.match((await f.vault.unlock()).token,/^[a-f0-9]{64}$/);});
test('strict 1Password byte arrays supported',async()=>{const f=await fixture({array:true});assert.equal((await f.vault.create()).ownerHash,(await f.vault.unlock()).ownerHash);});
test('different workspace/origin/scope derives a different capability',async()=>{
  const f=await fixture(),a=await f.vault.unlock();for(const change of [{scope:'/other/'},{origin:'https://other.example'},{policy:{...policy,configRepo:'other/config'}},{policy:{...policy,enclaveURL:'https://other.example'}}]){const other=passkeys({...identity,...change,credentials:f.credentials});await other.ready();assert.notEqual((await other.unlock()).token,a.token);}
});
test('missing PRF, malformed output and all-zero output fail closed',async()=>{
  await assert.rejects((await fixture({enabled:false})).vault.create(),/cannot unlock/);await assert.rejects((await fixture({zero:true})).vault.unlock(),/cannot unlock/);
  const f=await fixture();f.credentials.get=async()=>({type:'public-key',getClientExtensionResults:()=>({prf:{results:{first:Array(32).fill(256)}}})});await assert.rejects(f.vault.unlock(),/cannot unlock/);
});
test('unstable provider yields distinct confirmation hash; cancellation propagates',async()=>{
  const f=await fixture({changing:true});assert.notEqual((await f.vault.create()).ownerHash,(await f.vault.unlock()).ownerHash);f.credentials.get=async()=>{throw new DOMException('cancel','NotAllowedError');};await assert.rejects(f.vault.unlock(),{name:'NotAllowedError'});
});
test('native credential prompt starts synchronously within the click gesture',async()=>{const f=await fixture();const creating=f.vault.create();assert.equal(f.calls[0][0],'create');await creating;const unlocking=f.vault.unlock();assert.equal(f.calls[1][0],'get');await unlocking;});
