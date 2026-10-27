import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto as crypto} from 'node:crypto';
import {passkeys,encode} from './passkeys.js';
const policy={enclaveURL:'https://workspace.example',configRepo:'owner/config'};
const token='a'.repeat(64),identity={crypto,policy,origin:'https://app.example',scope:'/darcy-web/'};
export function provider({createOutput=true,array=false,enabled=true,changing=false}={}){
  const calls=[],id=new Uint8Array([1,2,3,4]);let gets=0;
  const result=()=>array?Array(32).fill(changing?++gets:7):new Uint8Array(32).fill(changing?++gets:7).buffer;
  const credentials={
    async create(args){calls.push(['create',args]);return{type:'public-key',rawId:id,getClientExtensionResults:()=>({prf:enabled?{enabled:true,...(createOutput?{results:{first:result()}}:{})}:{}})};},
    async get(args){calls.push(['get',args]);return{type:'public-key',rawId:id,getClientExtensionResults:()=>({prf:{results:{first:result()}}})};},
  };return{credentials,calls,id};
}
function fixture(config){const p=provider(config);return{...p,vault:passkeys({...identity,credentials:p.credentials})};}
test('real HKDF/AES-GCM wrap and fresh PRF unlock; no plaintext in persisted record',async()=>{
  const f=fixture(),record=await f.vault.create(token);assert(!JSON.stringify(record).includes(token));assert.equal(await f.vault.open(record),token);
  assert.equal(f.calls[0][1].publicKey.authenticatorSelection.userVerification,'required');
  assert.equal(f.calls[1][1].publicKey.userVerification,'required');
  assert.notDeepEqual(f.calls[0][1].publicKey.challenge,f.calls[1][1].publicKey.challenge);
  assert.equal(f.calls[0][1].publicKey.authenticatorSelection.authenticatorAttachment,undefined,'user chooses provider');
  assert.deepEqual(Object.keys(record).sort(),['version','origin','scope','enclaveURL','configRepo','credentialId','salt','iv','ciphertext'].sort());
});
test('Safari-style registration without PRF result needs explicit evaluation, then round-trip',async()=>{
  const f=fixture({createOutput:false}),descriptor=await f.vault.create(token);assert(!descriptor.ciphertext);
  const record=await f.vault.seal(token,descriptor);assert.equal(await f.vault.open(record),token);assert.equal(f.calls.filter(c=>c[0]==='get').length,2);
});
test('strict 1Password byte-array output interoperability',async()=>{
  const f=fixture({array:true}),record=await f.vault.create(token);assert.equal(await f.vault.open(record),token);
});
test('unsupported PRF fails closed; no plaintext fallback',async()=>{
  const f=fixture({enabled:false});await assert.rejects(f.vault.create(token),/cannot unlock/);
});
test('provider with unstable PRF cannot pass setup confirmation',async()=>{
  const f=fixture({changing:true}),record=await f.vault.create(token);await assert.rejects(f.vault.open(record),/Could not unlock/);
});
test('ciphertext, nonce, identity and key binding detect tampering',async()=>{
  const f=fixture(),record=await f.vault.create(token);
  for(const field of ['ciphertext','iv','salt']){const changed={...record,[field]:(record[field][0]==='A'?'B':'A')+record[field].slice(1)};await assert.rejects(f.vault.open(changed));}
  for(const field of ['origin','scope','configRepo','enclaveURL'])await assert.rejects(f.vault.open({...record,[field]:'other'}),/another workspace/);
  await assert.rejects(f.vault.open({...record,credentialId:encode(new Uint8Array([8]))}),/Choose the passkey/);
});
test('malformed records fail before a passkey prompt',async()=>{
  const f=fixture(),record=await f.vault.create(token),before=f.calls.length;
  for(const patch of [{version:2},{iv:'bad'},{ciphertext:'bad'},{salt:'bad'},{credentialId:''}])await assert.rejects(f.vault.open({...record,...patch}));
  assert.equal(f.calls.length,before);
});
test('PRF output length/type strictly checked and cancellation propagated',async()=>{
  const f=fixture(),record=await f.vault.create(token);
  f.credentials.get=async()=>({type:'public-key',rawId:f.id,getClientExtensionResults:()=>({prf:{results:{first:Array(32).fill(256)}}})});
  await assert.rejects(f.vault.open(record),/cannot unlock/);
  f.credentials.get=async()=>{throw new DOMException('cancel','NotAllowedError');};await assert.rejects(f.vault.open(record),{name:'NotAllowedError'});
});
