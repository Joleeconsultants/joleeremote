import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {UploadControl} from '../public/upload-control.js';
function fixture({ack=true,sendHook}={}){
  const events=[],sent=[],timers=new Map();let time=1000,ids=0,tid=0;
  const socket={readyState:1};
  const control=new UploadControl({id:()=>`id-${++ids}`,now:()=>time,
    timer:(f,ms)=>{timers.set(++tid,{f,ms});return tid;},clear:id=>timers.delete(id),
    encode:p=>new TextEncoder().encode('xx'+JSON.stringify(p)),report:e=>events.push(e),
    send:(frame,connection)=>{assert.equal(connection,socket);sent.push(JSON.parse(new TextDecoder().decode(frame).slice(2)));sendHook?.(control,sent.at(-1),socket);}});
  control.bind(socket,100000);control.capability(ack);
  const file={name:'café.txt',size:5,type:'text/plain',arrayBuffer:async()=>new TextEncoder().encode('hello').buffer};
  return {control,socket,file,events,sent,timers,time:v=>time=v,
    receipt:(extra={})=>({t:'file_upload_result',id:sent.at(-1)?.id,status:'saved',name:file.name,bytes:5,reason:null,...extra})};
}
test('saved requires matching receipt, including synchronous delivery after pending installed',async()=>{
  const f=fixture({sendHook:(c,p,s)=>c.consume({t:'file_upload_result',id:p.id,status:'saved',name:p.name,bytes:5,reason:null},s)});
  await f.control.upload(f.file);assert.deepEqual(f.events.map(e=>e.status),['start','end']);assert.equal(f.timers.size,0);
  assert.equal(f.events[0].requestId,f.events[1].requestId);
});
test('send alone is not success; mismatches and stale/duplicate replies cannot complete',async()=>{
  const f=fixture();await f.control.upload(f.file);assert.equal(f.events.length,1);
  for(const changed of [{id:'other'},{bytes:6},{name:'other'},{extra:1},{status:'saved',reason:'exists'}])f.control.consume(f.receipt(changed),f.socket);
  f.control.consume(f.receipt(),{});assert.equal(f.events.length,1);
  f.control.consume(f.receipt(),f.socket);f.control.consume(f.receipt(),f.socket);assert.equal(f.events.length,2);
});
test('legacy and stale capability send no id and explicitly leave completion unconfirmed',async()=>{
  for(const stale of [false,true]){const f=fixture({ack:stale});if(stale)f.time(7000);
    await f.control.upload(f.file);assert.equal(f.sent[0].id,undefined);assert.equal(f.events.at(-1).status,'warning');assert.equal(f.control.pending,null);}
});
test('bounded rejection codes and uncertain outcomes',async()=>{
  for(const reason of ['invalid_request','too_large','exists','unavailable','cancelled','write_failed','limit_reached']){
    const f=fixture();await f.control.upload(f.file);f.control.consume(f.receipt({status:'rejected',reason,name:null,bytes:null}),f.socket);assert.equal(f.events.at(-1).status,'error');}
  for(const reason of ['cleanup_failed','completion_unknown']){const f=fixture();await f.control.upload(f.file);f.control.consume(f.receipt({status:'uncertain',reason,name:null,bytes:null}),f.socket);assert.equal(f.events.at(-1).status,'warning');}
});
test('disconnect during read cancels ownership and does not send or automatically retry',async()=>{
  const f=fixture();let resolve;f.file.arrayBuffer=()=>new Promise(r=>resolve=r);
  const work=f.control.upload(f.file);f.control.bind(null);resolve(new ArrayBuffer(5));await work;
  assert.equal(f.sent.length,0);assert.equal(f.events.at(-1).status,'warning');f.control.bind(f.socket);assert.equal(f.sent.length,0);
});
test('timeout and expiry give unknown, suppress late replies and cap timer',async()=>{
  const f=fixture();f.control.bind(f.socket,1500);await f.control.upload(f.file);
  assert.equal([...f.timers.values()][0].ms,500);f.time(1500);f.control.consume(f.receipt(),f.socket);assert.equal(f.events.at(-1).status,'warning');
  const g=fixture();await g.control.upload(g.file);[...g.timers.values()][0].f();g.control.consume(g.receipt(),g.socket);assert.equal(g.events.at(-1).status,'warning');assert.equal(g.sent.length,1);
});
test('oversize before read, exact envelope overhead, read failure and disconnected preflight',async()=>{
  const f=fixture();let reads=0;await f.control.upload({...f.file,size:1024*1024,arrayBuffer:()=>{reads++;}});assert.equal(reads,0);assert.equal(f.sent.length,0);
  const g=fixture();await g.control.upload({...g.file,size:786432,arrayBuffer:async()=>new ArrayBuffer(786432)});assert.equal(g.sent.length,0);assert.equal(g.events.at(-1).status,'error');
  const h=fixture();await h.control.upload({...h.file,arrayBuffer:async()=>{throw Error('private path');}});assert.equal(h.events.at(-1).status,'error');assert.ok(!JSON.stringify(h.events).includes('private path'));
  const j=fixture();j.control.bind(null);await j.control.upload(j.file);assert.equal(j.sent.length,0);
});
test('only one pending operation; filename reuse gets independent notification IDs',async()=>{
  const f=fixture();await f.control.upload(f.file);await f.control.upload(f.file);assert.equal(f.sent.length,1);
  f.control.consume(f.receipt(),f.socket);await f.control.upload(f.file);assert.equal(f.sent.length,2);assert.notEqual(f.sent[0].id,f.sent[1].id);
});
test('shipped picker, viewer and original notifications connect receipt path',()=>{
  const shell=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const viewer=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
  const sidebar=readFileSync(new URL('../chrome/selkies-dashboard/src/components/Sidebar.jsx',import.meta.url),'utf8');
  assert.match(shell,/postToCore\(\{ type: "fileUpload", file: file \}\)/);
  assert.match(viewer,/await uploadControl.upload\(blob\)/);assert.match(viewer,/uploadControl.consume\(parseJsonFrameObject\(env.payload\),currentSocket\)/);
  assert.match(viewer,/uploadControl.bind\(sessionPaired\?socket:null,expiresAt\)/);assert.match(sidebar,/`upload:\$\{message.payload.requestId\}`/);
});
