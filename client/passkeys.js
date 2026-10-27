// The passkey PRF derives the workspace capability. No access-key file, wrapped
// credential or plaintext login is stored. Only a public enrollment hash leaves
// this module until a freshly attested workspace accepts the derived capability.
const utf8=new TextEncoder();
export const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const hex=bytes=>[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
const unsupported=()=>new Error('This provider cannot unlock encrypted workspaces. Choose another passkey provider.');
function prfBytes(value){
  let bytes;
  if(Array.isArray(value)&&value.length===32&&value.every(n=>Number.isInteger(n)&&n>=0&&n<=255))bytes=Uint8Array.from(value);
  else if(value instanceof ArrayBuffer)bytes=new Uint8Array(value.slice(0));
  else if(ArrayBuffer.isView(value))bytes=new Uint8Array(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
  if(bytes?.length!==32||bytes.every(n=>n===0))throw unsupported();return bytes;
}
export function passkeys({credentials,crypto,policy,origin,scope}){
  const rpId=new URL(origin).hostname,random=n=>crypto.getRandomValues(new Uint8Array(n));
  const context=utf8.encode(JSON.stringify({purpose:'Darcy passkey workspace capability v1',origin,scope,enclaveURL:new URL(policy.enclaveURL).origin,configRepo:policy.configRepo}));
  const salt=()=>crypto.subtle.digest('SHA-256',context).then(v=>new Uint8Array(v));
  async function capability(value){
    const bytes=prfBytes(value);let derived;
    try{
      const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveBits']);
      derived=new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:await salt(),info:context},material,256));
      const token=hex(derived),ownerHash=hex(await crypto.subtle.digest('SHA-256',utf8.encode(token)));
      return{token,ownerHash};
    }finally{bytes.fill(0);derived?.fill(0);}
  }
  function supported(){if(!credentials?.create||!credentials?.get||!crypto?.subtle)throw unsupported();}
  return{
    async create(signal){
      supported();const first=await salt();
      const credential=await credentials.create({signal,publicKey:{rp:{id:rpId,name:'Darcy'},user:{id:random(32),name:'Darcy',displayName:'Darcy'},challenge:random(32),pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{residentKey:'required',userVerification:'required'},attestation:'none',timeout:60000,extensions:{prf:{eval:{first}}}}});
      const extension=credential?.getClientExtensionResults()?.prf;
      if(credential?.type!=='public-key'||(!extension?.enabled&&!extension?.results?.first))throw unsupported();
      if(!extension.results?.first)return{ownerHash:null};
      const result=await capability(extension.results.first);return{ownerHash:result.ownerHash};
    },
    async unlock(signal){
      supported();const first=await salt();
      // Discoverable credentials let synced passkeys work on a fresh device.
      const credential=await credentials.get({signal,publicKey:{rpId,challenge:random(32),userVerification:'required',timeout:60000,extensions:{prf:{eval:{first}}}}});
      if(credential?.type!=='public-key')throw unsupported();
      return capability(credential.getClientExtensionResults()?.prf?.results?.first);
    },
  };
}
