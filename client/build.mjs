import {build} from 'esbuild';
import {mkdir,readFile,writeFile,rm,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const html=await readFile('index.html','utf8');
const css=await readFile('style.css','utf8');
const deployment=JSON.parse(await readFile('deployment.json','utf8'));
// Keep executable and visual resources in the reviewed, locally served bundle.
assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)].map(m=>m[1]),['./app.js'],'Only the local app bundle may run');
assert.equal((html.match(/<script\b/g)||[]).length,1,'Inline scripts are forbidden');
assert.deepEqual([...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map(m=>m[1]),['./style.css'],'Only local styles may load');
assert(!/\son[a-z]+\s*=|<(?:iframe|object|embed|base)\b|\sstyle\s*=/i.test(html),'No active embeds, inline event handlers, or inline styles');
assert(!/@import\b|url\s*\(/i.test(css),'No remote CSS assets or fonts');
const policy=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
assert(policy,'CSP is required');
for(const directive of ["default-src 'none'","script-src 'self'","style-src 'self'","object-src 'none'","base-uri 'none'","form-action 'none'","worker-src 'none'"])assert(policy.includes(directive),`Missing CSP: ${directive}`);
assert(!/unsafe-inline|unsafe-eval|https:;|connect-src \*;/.test(policy),'CSP must not permit broad script execution or network access');
const origins=['https://atc.tinfoil.sh'];
if(!deployment.enclaveURL)origins.push('http://localhost:*','http://127.0.0.1:*','http://[::1]:*');
if(deployment.enclaveURL){const endpoint=new URL(deployment.enclaveURL);assert.equal(endpoint.protocol,'https:','Pinned deployment must use HTTPS');origins.push(endpoint.origin);}
const outputHTML=html.replace(/connect-src [^;]+;/,`connect-src ${[...new Set(origins)].join(' ')};`);
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
// Verifier1.3.0 includes a Node-only gzip fallback. Browsers must use their native
// DecompressionStream; missing support fails closed instead of loading a polyfill.
const browserGzip={name:'native-browser-gzip',setup(builder){
  builder.onResolve({filter:/^zlib$/},args=>{assert(args.importer.endsWith('/@tinfoilsh/verifier/dist/attestation.js'),'Unexpected Node dependency');return{path:'unsupported-node-gzip',namespace:'browser-only'};});
  builder.onLoad({filter:/.*/,namespace:'browser-only'},()=>({contents:"export function gunzipSync(){throw new Error('This browser needs native DecompressionStream support.');}",loader:'js'}));
}};
const result=await build({entryPoints:['app.js'],bundle:true,outfile:'dist/app.js',format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'eof',metafile:true,plugins:[browserGzip]});
const bundle=await readFile('dist/app.js','utf8');
const packages=new Set();
for(const input of Object.keys(result.metafile.inputs)){
  const matches=[...input.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  if(matches.length){const match=matches.at(-1);packages.add(input.slice(0,match.index+match[0].length));}
}
const notices=[];
for(const directory of [...packages].sort()){
  const pkg=JSON.parse(await readFile(`${directory}/package.json`,'utf8'));
  let license='';
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT','LICENCE','LICENCE.md']){
    try{license=await readFile(`${directory}/${file}`,'utf8');break;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  notices.push(`${pkg.name} ${pkg.version}\nLicense: ${pkg.license||'See package metadata'}\n${license}`);
}
await writeFile('dist/THIRD-PARTY-NOTICES.txt',notices.join('\n\n---\n\n'));
assert(!/\beval\s*\(|\bnew\s+Function\s*\(|\bnew\s+(?:Shared)?Worker\s*\(/.test(bundle),'Bundle must not load executable code dynamically');
assert(!Object.keys(result.metafile.outputs).some(name=>/\.(?:wasm|node)$/.test(name)),'Unexpected external runtime resource');
assert(!Object.values(result.metafile.outputs).some(output=>output.imports.some(item=>item.external)),'All runtime imports must be bundled locally');
const hash=(algorithm,value)=>createHash(algorithm).update(value).digest(algorithm==='sha384'?'base64':'hex');
const scriptName=`app.${hash('sha256',bundle).slice(0,24)}.js`,styleName=`style.${hash('sha256',css).slice(0,24)}.css`;
await rename('dist/app.js',`dist/${scriptName}`);
await writeFile(`dist/${styleName}`,css);
const finalHTML=outputHTML.replace('src="./app.js"',`src="./${scriptName}" integrity="sha384-${hash('sha384',bundle)}" crossorigin="anonymous"`).replace('href="./style.css"',`href="./${styleName}" integrity="sha384-${hash('sha384',css)}" crossorigin="anonymous"`);
await writeFile('dist/index.html',finalHTML);
await writeFile('dist/checksums.json',JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain','--','.'],{encoding:'utf8'}).trim(),sha256:{'index.html':hash('sha256',finalHTML),[scriptName]:hash('sha256',bundle),[styleName]:hash('sha256',css)}},null,2)+'\n');
console.log(`Built web/dist; local assets, CSP, and self-contained browser bundle checked (${bundle.length.toLocaleString()} bytes).`);
