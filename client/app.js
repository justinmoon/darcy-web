import {connect,request,subscribe,disconnect,defaultConnection} from './transport.js';

if(window.top!==window.self){
  document.body.replaceChildren(document.createTextNode('Open Darcy directly in its own tab.'));
  throw new Error('Embedded sessions are disabled.');
}

const $=id=>document.getElementById(id);
const MAX_FILE=16*1024*1024;
const model={connected:false,verification:false,development:false,connecting:false,sending:false,transferring:false,snapshot:null,pending:[],viewingHistory:false,config:null};
let messageSignature='', fileSignature='',connectionEpoch=0,loadingHistory=false,unsubscribe=null,filePickerEpoch=null,phoneState=null,phoneBusy=false;
const openTools=new Set();
const icons={download:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/></svg>'};

function error(message){$('error-text').textContent=String(message||'Something went wrong. Reconnect before retrying an uncertain task.');$('error-panel').hidden=false;}
function clearError(){$('error-panel').hidden=true;}
function clearSession(){
  connectionEpoch++;unsubscribe?.();unsubscribe=null;disconnect();
  Object.assign(model,{connected:false,verification:false,development:false,connecting:false,sending:false,transferring:false,snapshot:null,pending:[],viewingHistory:false,config:null});
  loadingHistory=false;filePickerEpoch=null;phoneState=null;phoneBusy=false;messageSignature='';fileSignature='';openTools.clear();
  $('phone-npub').value='';$('phone-agent-key').textContent='';
  $('message-input').value='';$('owner-token').value='';$('file-input').value='';
  $('older-button').disabled=false;$('latest-button').disabled=false;
  return connectionEpoch;
}
function operationError(cause,epoch){
  if(epoch!==connectionEpoch)return;
  if(cause.reconnectRequired){clearSession();render();}
  error(cause.message||'Task outcome uncertain. Reconnect before retrying.');
}
function currentChat(){const s=model.snapshot;return s?.chats?.find(chat=>chat.id===s.current)||s?.chats?.[0]||null;}
function ready(){return model.connected&&model.snapshot?.verified===true;}
function busy(){return model.snapshot?.busy===true;}
function setConnectionBadge(){
  const badge=$('connection-badge');badge.classList.toggle('verified',model.connected&&model.verification);badge.classList.toggle('development',model.connected&&model.development);
  $('connection-label').textContent=model.connecting?'Verifying workspace…':!model.connected?'Not connected':model.verification?'TEE connection verified':'Unverified development';
  $('fact-verification').textContent=!model.connected?'Not connected':model.verification?'Endpoint attestation verified':'Unverified localhost development';
}
function syncComposer(){
  $('send-button').disabled=!ready()||busy()||model.sending||model.transferring||!$('message-input').value.trim();
  $('message-input').disabled=!ready();
  $('attach-button').disabled=!ready()||busy()||model.sending||model.transferring;
  $('stop-button').hidden=!busy();$('send-button').hidden=busy();
  $('stop-button').disabled=!model.connected;
  $('composer-hint').hidden=!model.transferring&&!model.development&&model.snapshot?.storage!=='temporary';
  $('composer-hint').textContent=model.transferring?'Copying selected file…':model.development?'Local development · not verified':model.snapshot?.storage==='temporary'?'Temporary test workspace · erased when its TEE restarts.':'Files stay in this workspace.';
}
function renderPending(){
  const list=$('pending-attachments');list.replaceChildren();list.hidden=!model.pending.length;
  const epoch=connectionEpoch;for(const item of model.pending){const chip=document.createElement('span');chip.className='attachment-chip';const name=document.createElement('span');name.textContent=item.name;name.title=item.name;const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${item.name} from this message`);remove.addEventListener('click',()=>{if(epoch!==connectionEpoch)return;model.pending=model.pending.filter(x=>x.path!==item.path);renderPending();});chip.append(name,remove);list.append(chip);}
}
function renderBody(container,text){
  // Treat all model output as data. No HTML, external images, scripts, or embeds.
  container.replaceChildren();const blocks=String(text||'').split(/```[^\n]*\n([\s\S]*?)```/g);
  blocks.forEach((block,index)=>{if(!block)return;const node=document.createElement(index%2?'pre':'p');if(index%2){const code=document.createElement('code');code.textContent=block;node.append(code);}else{
    for(const part of block.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g)){
      if(part.startsWith('**')&&part.endsWith('**')){const strong=document.createElement('strong');strong.textContent=part.slice(2,-2);node.append(strong);}
      else if(part.startsWith('`')&&part.endsWith('`')){const code=document.createElement('code');code.textContent=part.slice(1,-1);node.append(code);}
      else node.append(document.createTextNode(part));
    }
  }container.append(node);});
}
function nearBottom(){return window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-180;}
function renderMessages(){
  const chat=currentChat(),messages=Array.isArray(chat?.messages)?chat.messages:[];
  $('empty-chat').hidden=messages.length>0;
  $('older-button').hidden=!chat?.has_more||busy();$('latest-button').hidden=!model.viewingHistory;
  const signature=JSON.stringify([chat?.id,messages,busy()]);if(signature===messageSignature)return;
  const follow=nearBottom(),list=$('messages');messageSignature=signature;
  list.replaceChildren();
  for(const [index,message] of messages.entries()){
    if(!['user','assistant','tool'].includes(message.role))continue;
    if(message.role==='tool')continue;
    const article=document.createElement('article');article.className=`message ${message.role}`;
    if(message.role==='assistant'&&index===messages.length-1&&busy())article.classList.add('pending');
    const label=document.createElement('div');label.className='message-label';
    if(message.role==='assistant'){const mark=document.createElement('span');mark.className='agent-mark';mark.textContent='✳';mark.setAttribute('aria-hidden','true');label.append(mark);}
    label.append(document.createTextNode(message.role==='user'?'You':'Darcy'));
    const body=document.createElement('div');body.className='message-body';renderBody(body,message.text);
    article.append(label,body);
    const tools=Array.isArray(message.tools)?message.tools:[];
    if(tools.length){
      const key=`${chat.id}:${message.id??index}`,details=document.createElement('details');details.className='tool-details';details.open=openTools.has(key);
      details.addEventListener('toggle',()=>{if(details.open)openTools.add(key);else openTools.delete(key);});
      const summary=document.createElement('summary');summary.textContent=`${tools.length} ${tools.length===1?'tool action':'tool actions'}`;
      const items=document.createElement('div');items.className='tool-list';
      for(const tool of tools){const item=document.createElement('div');item.className='tool-item';const name=document.createElement('span');name.className='tool-name';name.textContent=tool.name||'Tool';item.append(name);if(tool.arguments!=null){const args=document.createElement('pre');args.textContent=typeof tool.arguments==='string'?tool.arguments:JSON.stringify(tool.arguments,null,2);item.append(args);}items.append(item);}
      details.append(summary,items);article.append(details);
    }
    list.append(article);
  }
  if(follow&&!model.viewingHistory){const epoch=connectionEpoch;requestAnimationFrame(()=>{if(epoch===connectionEpoch)window.scrollTo({top:document.documentElement.scrollHeight,behavior:'auto'});});}
}
function formatSize(bytes){if(bytes<1024)return`${bytes} B`;if(bytes<1024*1024)return`${(bytes/1024).toFixed(1)} KB`;return`${(bytes/(1024*1024)).toFixed(1)} MB`;}
function renderFiles(){
  const files=(model.snapshot?.files||[]).filter(f=>f.kind!=='attachment'&&typeof f.path==='string').slice(0,100);
  const signature=JSON.stringify(files);if(signature===fileSignature)return;fileSignature=signature;
  $('result-count').textContent=String(files.length);$('result-panel').hidden=!files.length;const list=$('result-files');list.replaceChildren();
  const epoch=connectionEpoch;for(const file of files){const button=document.createElement('button');button.type='button';button.className='result-file';button.title=`Save ${file.name||file.path}`;
    const description=document.createElement('span'),name=document.createElement('span'),size=document.createElement('span');name.className='file-name';name.textContent=file.name||file.path;size.className='file-size';size.textContent=`${formatSize(Number(file.size)||0)} · Save`;description.append(name,size);button.append(description);button.insertAdjacentHTML('beforeend',icons.download);button.addEventListener('click',()=>{if(epoch===connectionEpoch)download(file,button);});list.append(button);}
}
function render(){
  $('setup-panel').hidden=model.connected;$('conversation-panel').hidden=!model.connected;$('workspace-footer').hidden=!model.connected;
  $('connect-submit').disabled=model.connecting;$('connect-submit').firstElementChild.textContent=model.connecting?'Verifying workspace…':'Connect workspace';
  setConnectionBadge();syncComposer();
  $('disconnect-button').hidden=!model.connected;$('disconnect-note').hidden=!model.connected;
  const s=model.snapshot||{};$('workspace-status').textContent=s.status||(model.connected?'Connecting…':'Not connected');$('working-label').textContent=busy()?'Working':'';
  $('messages').setAttribute('aria-busy',String(busy()));
  $('fact-inference').textContent=s.inference||'Not connected';$('fact-execution').textContent=s.execution||'Not connected';
  $('fact-endpoint').textContent=model.config?.enclaveURL||'—';$('fact-config').textContent=model.config?.configRepo||'—';
  renderMessages();renderFiles();renderPending();renderPhone();
}
function renderPhone(){
  $('phone-panel').hidden=!model.connected||model.snapshot?.phone?.enabled!==true;
  const paired=!!phoneState?.phone_npub;
  $('phone-status').textContent=phoneBusy?'Updating phone settings…':phoneState?.localError||phoneState?.error||(phoneState?.pairing_uncertain?'Invitation unfinished. Disconnect the phone and try again.':paired?'Phone invited. Accept Darcy’s invitation in WhiteNoise.':phoneState?.ready?'No phone paired.':'Phone connection is starting. Refresh in a moment.');
  $('phone-agent-key').textContent=phoneState?.account_npub?`Darcy identity: ${phoneState.account_npub}`:'';
  $('phone-pair').hidden=paired;$('phone-revoke').hidden=!paired&&!phoneState?.pairing_uncertain;
  $('phone-pair').disabled=phoneBusy||!phoneState?.ready;
  $('phone-revoke').disabled=phoneBusy||!Number.isSafeInteger(phoneState?.revision);
  $('phone-refresh').disabled=phoneBusy;$('phone-npub').disabled=phoneBusy||paired;
  if(paired)$('phone-npub').value=phoneState.phone_npub;
}
async function loadPhone(){
  if(!model.connected||!model.snapshot?.phone?.enabled||phoneBusy)return;
  const epoch=connectionEpoch;phoneBusy=true;renderPhone();
  try{const state=await request('phone_status');if(epoch!==connectionEpoch)return;phoneState=state;}
  catch(e){if(epoch!==connectionEpoch)return;if(e.reconnectRequired)operationError(e,epoch);else phoneState={...phoneState,localError:e.message};}
  finally{if(epoch===connectionEpoch){phoneBusy=false;renderPhone();}}
}
async function changePhone(action){
  if(phoneBusy||!model.connected||!Number.isSafeInteger(phoneState?.revision))return;
  const epoch=connectionEpoch,args={expected_revision:phoneState.revision};
  if(action==='phone_pair'){
    args.npub=$('phone-npub').value.trim();
    if(!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(args.npub)){$('phone-npub').value='';phoneState={...phoneState,localError:'Paste the public npub from your phone profile.'};renderPhone();return;}
  }
  phoneBusy=true;renderPhone();
  try{
    await request(action,args);if(epoch!==connectionEpoch)return;
    if(action==='phone_revoke')$('phone-npub').value='';
    const state=await request('phone_status');if(epoch!==connectionEpoch)return;phoneState=state;
  }catch(e){if(epoch!==connectionEpoch)return;if(e.reconnectRequired)operationError(e,epoch);else phoneState={...phoneState,localError:e.message};}
  finally{if(epoch===connectionEpoch){phoneBusy=false;renderPhone();}}
}
$('phone-refresh').addEventListener('click',loadPhone);
$('phone-pair').addEventListener('click',()=>changePhone('phone_pair'));
$('phone-revoke').addEventListener('click',()=>changePhone('phone_revoke'));
function accept(value,epoch=connectionEpoch){
  if(epoch!==connectionEpoch)return;
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){if(model.snapshot){model.snapshot.files=value;renderFiles();}return;}
  if(value.event==='error'){
    if(value.reconnectRequired){clearSession();render();}
    error(value.error||value.message);return;
  }
  if(value.event==='file_imported'||(!value.event&&typeof value.path==='string')){
    if(!model.pending.some(file=>file.path===value.path))model.pending.push({path:value.path,name:value.name||value.path.split('/').at(-1)});renderPending();return;
  }
  const snapshot=value.event==='state'?value.data:value.snapshot||((Array.isArray(value.chats)||typeof value.busy==='boolean')?value:null);
  if(snapshot){
    // Polling updates readiness and files without replacing the page being read.
    // Explicit history responses are plain snapshots and replace that page.
    const keepPage=value.event==='state'&&model.viewingHistory&&!snapshot.busy;
    model.snapshot=keepPage?{...snapshot,chats:model.snapshot?.chats,current:model.snapshot?.current}:snapshot;
    if(snapshot.busy)model.viewingHistory=false;if(snapshot.error)error(snapshot.error);render();
  }
}
function validConnection(){
  const enclaveURL=$('enclave-url').value.trim(),configRepo=$('config-repo').value.trim(),token=$('owner-token').value.trim();
  const url=new URL(enclaveURL),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash)throw new Error('Use a workspace address without credentials, query parameters or a fragment.');
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'&&$('allow-local-dev').checked))throw new Error('Use HTTPS. Unverified localhost development needs explicit permission below.');
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configRepo))throw new Error('Use the expected repository in owner/repository form.');
  if(!token||token.length>4096||/[\r\n]/.test(token))throw new Error('Enter a valid workspace access key.');
  return{enclaveURL:url.href.replace(/\/$/,''),configRepo,token,allowLocalDev:local&&$('allow-local-dev').checked};
}
function syncDevelopmentOption(){let local=false;try{local=['localhost','127.0.0.1','[::1]'].includes(new URL($('enclave-url').value).hostname);}catch{}$('dev-option').hidden=!local;if(!local)$('allow-local-dev').checked=false;}
$('enclave-url').value=defaultConnection.enclaveURL||'';
$('config-repo').value=defaultConnection.configRepo||'';
if(defaultConnection.releaseDigest){
  for(const id of ['enclave-url','config-repo']){
    $(id).readOnly=true;$(id).hidden=true;
    document.querySelector(`label[for="${id}"]`).hidden=true;
  }
}
let keyPickerEpoch=null;
$('key-file-button').addEventListener('click',()=>{
  if(model.connected||model.connecting)return;
  keyPickerEpoch=connectionEpoch;$('key-file-input').click();
});
$('key-file-input').addEventListener('change',async()=>{
  const file=$('key-file-input').files?.[0],epoch=keyPickerEpoch;
  $('key-file-input').value='';keyPickerEpoch=null;
  if(!file||epoch!==connectionEpoch||model.connected||model.connecting)return;
  try{
    if(file.size>512)throw new Error('Choose the small access-key file.');
    const key=(await file.text()).trim();
    if(epoch!==connectionEpoch||model.connected||model.connecting)return;
    if(!/^[a-f0-9]{64}$/.test(key))throw new Error('This is not a Darcy access-key file.');
    $('owner-token').value=key;clearError();
  }catch(e){if(epoch===connectionEpoch)error(e.message);}
});
syncDevelopmentOption();
$('enclave-url').addEventListener('input',syncDevelopmentOption);
$('connect-form').addEventListener('submit',async event=>{
  event.preventDefault();if(model.connecting)return;clearError();let options;
  try{options=validConnection();}catch(e){error(e.message);return;}
  const epoch=clearSession();unsubscribe=subscribe(value=>accept(value,epoch));
  model.connecting=true;render();
  try{
    const response=await connect(options);if(epoch!==connectionEpoch)return;
    const verified=response?.verification===true,development=response?.mode==='dev'&&options.allowLocalDev;
    if(!verified&&!development){disconnect();throw new Error('Workspace verification did not pass. No private conversation is opened.');}
    model.connected=true;model.verification=verified;model.development=!verified;model.config={enclaveURL:options.enclaveURL,configRepo:options.configRepo};options.token='';
    if(response?.snapshot)accept(response.snapshot,epoch);else{const snapshot=await request('state',{});if(epoch!==connectionEpoch)return;accept(snapshot,epoch);}
  }catch(e){if(epoch!==connectionEpoch)return;clearSession();error(e.message);render();}finally{options.token='';if(epoch===connectionEpoch){model.connecting=false;render();if(ready())$('message-input').focus();}}
});
$('message-input').addEventListener('input',()=>{const input=$('message-input');input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,220)}px`;syncComposer();});
$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send-button').disabled)$('message-form').requestSubmit();}});
$('message-form').addEventListener('submit',async event=>{
  event.preventDefault();const input=$('message-input'),text=input.value.trim();if(!ready()||busy()||model.sending||!text)return;
  const epoch=connectionEpoch,pending=[...model.pending];const prompt=pending.length?`${text}\n\nAttached workspace files:\n${pending.map(file=>`- ${file.path}`).join('\n')}`:text;
  if(new TextEncoder().encode(prompt).length>32768){error('This message is too long. Keep it within 32 KiB, including attachment references.');return;}
  clearError();model.sending=true;input.value='';input.style.height='auto';model.pending=[];model.viewingHistory=false;render();
  try{const response=await request('send',{text:prompt});if(epoch!==connectionEpoch)return;accept(response,epoch);}catch(e){operationError(e,epoch);}finally{if(epoch===connectionEpoch){model.sending=false;render();if(ready())input.focus();}}
});
$('stop-button').addEventListener('click',async()=>{if(!model.connected)return;const epoch=connectionEpoch;clearError();$('stop-button').disabled=true;try{const response=await request('stop',{});if(epoch!==connectionEpoch)return;accept(response,epoch);}catch(e){operationError(e,epoch);}finally{if(epoch===connectionEpoch)syncComposer();}});
$('attach-button').addEventListener('click',()=>{if(!ready()||busy())return;filePickerEpoch=connectionEpoch;$('file-input').click();});
function base64(bytes){let result='';const size=32768;for(let i=0;i<bytes.length;i+=size)result+=String.fromCharCode(...bytes.subarray(i,i+size));return btoa(result);}
$('file-input').addEventListener('change',async()=>{
  const epoch=filePickerEpoch;filePickerEpoch=null;const file=$('file-input').files?.[0];$('file-input').value='';if(epoch!==connectionEpoch||!file||!ready()||busy()||model.transferring)return;
  if(file.size>MAX_FILE){error('Choose a file no larger than 16 MiB.');return;}
  clearError();model.transferring=true;render();
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());if(epoch!==connectionEpoch)return;
    if(bytes.byteLength>MAX_FILE)throw new Error('File exceeds 16 MiB.');
    const response=await request('import_file',{name:file.name,data_base64:base64(bytes)});if(epoch!==connectionEpoch)return;accept(response,epoch);if(epoch!==connectionEpoch)return;
    const files=await request('files',{});if(epoch!==connectionEpoch)return;accept(files,epoch);
  }catch(e){operationError(e,epoch);}finally{if(epoch===connectionEpoch){model.transferring=false;render();}}
});
async function download(file,button){
  if(!model.connected)return;const epoch=connectionEpoch;clearError();button.disabled=true;
  try{
    const response=await request('export_file',{path:file.path});if(epoch!==connectionEpoch)return;
    const data=response?.data_base64??response?.data?.data_base64;if(typeof data!=='string'||data.length>Math.ceil(MAX_FILE/3)*4+4)throw new Error('Invalid or oversized file response.');
    const raw=atob(data),bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));if(bytes.byteLength>MAX_FILE)throw new Error('File exceeds 16 MiB.');
    const blob=new Blob([bytes],{type:'application/octet-stream'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=String(response.name||file.name||'workspace-file').split(/[\\/]/).at(-1);document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch(e){operationError(e,epoch);}finally{if(epoch===connectionEpoch)button.disabled=false;}
}
$('refresh-files').addEventListener('click',async()=>{if(!model.connected)return;const epoch=connectionEpoch;try{const files=await request('files',{});if(epoch!==connectionEpoch)return;accept(files,epoch);}catch(e){operationError(e,epoch);}});
async function historyPage(older){
  const chat=currentChat();if(!model.connected||loadingHistory||(older&&(!chat?.has_more||busy())))return;
  const epoch=connectionEpoch;loadingHistory=true;$('older-button').disabled=true;$('latest-button').disabled=true;
  try{
    const page=await request('history',older?{chat:chat.id,before:chat.before}:{});if(epoch!==connectionEpoch)return;
    model.viewingHistory=older&&!page.busy;accept(page,epoch);window.scrollTo({top:older?0:document.documentElement.scrollHeight,behavior:'auto'});
  }catch(e){operationError(e,epoch);}finally{if(epoch===connectionEpoch){loadingHistory=false;$('older-button').disabled=false;$('latest-button').disabled=false;}}
}
$('older-button').addEventListener('click',()=>historyPage(true));
$('latest-button').addEventListener('click',()=>historyPage(false));
for(const id of ['connection-button','details-button'])$(id).addEventListener('click',()=>{$('connection-dialog').showModal();void loadPhone();});
$('disconnect-button').addEventListener('click',()=>{clearSession();$('connection-dialog').close();clearError();render();});
$('dismiss-error').addEventListener('click',clearError);
window.addEventListener('pagehide',()=>{clearSession();render();});
window.addEventListener('pageshow',render);
render();
