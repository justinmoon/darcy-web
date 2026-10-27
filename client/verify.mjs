// Public evidence only: no owner key, private request, or inference call.
import {SecureClient} from 'tinfoil';
import {readFile} from 'node:fs/promises';
const policy=JSON.parse(await readFile(new URL('./deployment.json',import.meta.url)));
const client=new SecureClient({enclaveURL:policy.enclaveURL,configRepo:policy.configRepo,baseURL:policy.enclaveURL+'/',transport:'ehbp'});
await client.ready();
const proof=client.getVerificationDocument();
if(!proof.securityVerified||proof.releaseDigest!==policy.releaseDigest||proof.configRepo!==policy.configRepo)throw new Error('Deployment verification mismatch');
console.log(JSON.stringify({securityVerified:proof.securityVerified,enclaveHost:proof.enclaveHost,configRepo:proof.configRepo,releaseDigest:proof.releaseDigest,steps:proof.steps},null,2));
