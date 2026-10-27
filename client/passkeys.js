// The browser/provider mediates WebAuthn. PRF protects the stored access key;
// the verified enclave, not a WebAuthn server, checks workspace authorization.
const utf8=new TextEncoder();
const unsupported=()=>new Error('This passkey provider cannot unlock encrypted workspaces. Choose another provider or use your recovery key.');
export const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function decode(text,min,max=min){
  if(typeof text!=='string'||text.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(text))throw new Error('Invalid saved passkey.');
  const bytes=Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  if(bytes.length<min||bytes.length>max||encode(bytes)!==text)throw new Error('Invalid saved passkey.');return bytes;
}
function prfBytes(value){
  // Some 1Password releases return a byte array instead of BufferSource.
  let bytes;
  if(Array.isArray(value)&&value.length===32&&value.every(n=>Number.isInteger(n)&&n>=0&&n<=255))bytes=Uint8Array.from(value);
  else if(value instanceof ArrayBuffer)bytes=new Uint8Array(value.slice(0));
  else if(ArrayBuffer.isView(value))bytes=new Uint8Array(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
  if(bytes?.length!==32)throw unsupported();return bytes;
}
export function passkeys({credentials,crypto,policy,origin,scope}){
  const identity={origin,scope,enclaveURL:new URL(policy.enclaveURL).origin,configRepo:policy.configRepo};
  const rpId=new URL(origin).hostname,random=n=>crypto.getRandomValues(new Uint8Array(n));
  const aad=r=>utf8.encode(JSON.stringify({version:1,...identity,credentialId:r.credentialId,salt:r.salt}));
  function validate(r,sealed=true){
    if(!r||r.version!==1||Object.entries(identity).some(([k,v])=>r[k]!==v))throw new Error('This saved passkey belongs to another workspace.');
    decode(r.credentialId,1,1024);decode(r.salt,32);
    if(sealed){decode(r.iv,12);decode(r.ciphertext,80);}return r;
  }
  async function key(bytes,r){
    try{const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:decode(r.salt,32),info:aad(r)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
    finally{bytes.fill(0);}
  }
  function supported(){if(!credentials?.create||!credentials?.get||!crypto?.subtle)throw unsupported();}
  async function evaluate(r,signal){
    supported();validate(r,false);
    const credential=await credentials.get({signal,publicKey:{rpId,challenge:random(32),allowCredentials:[{type:'public-key',id:decode(r.credentialId,1,1024)}],userVerification:'required',timeout:60000,extensions:{prf:{eval:{first:decode(r.salt,32)}}}}});
    if(!credential||credential.type!=='public-key'||encode(credential.rawId)!==r.credentialId)throw new Error('Choose the passkey used to set up this workspace.');
    return prfBytes(credential.getClientExtensionResults()?.prf?.results?.first);
  }
  async function sealBytes(token,r,bytes){
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid recovery key.');
    const wrappingKey=await key(bytes,r),iv=random(12),plaintext=utf8.encode(token);
    try{const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(r)},wrappingKey,plaintext);return{...r,iv:encode(iv),ciphertext:encode(ciphertext)};}
    finally{plaintext.fill(0);}
  }
  return {
    validate,
    async create(token,signal){
      supported();const salt=random(32);
      const credential=await credentials.create({signal,publicKey:{rp:{id:rpId,name:'Darcy'},user:{id:random(32),name:'Darcy workspace',displayName:'Darcy workspace'},challenge:random(32),pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{residentKey:'required',userVerification:'required'},attestation:'none',timeout:60000,extensions:{prf:{eval:{first:salt}}}}});
      if(!credential||credential.type!=='public-key')throw unsupported();
      const extension=credential.getClientExtensionResults()?.prf;
      if(!extension?.enabled&&!extension?.results?.first)throw unsupported();
      const descriptor={version:1,...identity,credentialId:encode(credential.rawId),salt:encode(salt)};validate(descriptor,false);
      return extension.results?.first?await sealBytes(token,descriptor,prfBytes(extension.results.first)):descriptor;
    },
    async seal(token,descriptor,signal){return sealBytes(token,validate(descriptor,false),await evaluate(descriptor,signal));},
    async open(record,signal){
      validate(record);const wrappingKey=await key(await evaluate(record,signal),record);let plaintext;
      try{plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(record.iv,12),additionalData:aad(record)},wrappingKey,decode(record.ciphertext,80)));const token=new TextDecoder('utf-8',{fatal:true}).decode(plaintext);if(!/^[a-f0-9]{64}$/.test(token))throw new Error();return token;}
      catch{throw new Error('Could not unlock with this passkey. Try again or use your recovery key.');}
      finally{plaintext?.fill(0);}
    },
  };
}
