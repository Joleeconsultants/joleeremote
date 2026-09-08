import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
function fixture(){
  const c=vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function createPointerInput('),html.indexOf('const pointerInput=')),c);
  const sent=[];let paired=true;
  const input=c.createPointerInput(m=>sent.push(JSON.parse(JSON.stringify(m))),e=>({x:e.x,y:e.y}),()=>paired);
  const e=(extra={})=>({pointerId:1,isPrimary:true,button:0,buttons:1,x:0.5,y:0.5,...extra});
  return {input,sent,e,unpair(){paired=false;input.reset();},pair(){paired=true;}};
}
test('drag outside the image clamps movement and release to valid coordinates',()=>{
  const f=fixture();f.input.down(f.e());f.input.move(f.e({x:1.5,y:-2}));f.input.up(f.e({x:2,y:-1,buttons:0}));
  assert.deepEqual(f.sent.map(m=>[m.e,m.x,m.y,m.b]),[['down',0.5,0.5,0],['move',1,0,1],['up',1,0,0]]);
});
test('cancel or lost capture releases each owned button once',()=>{
  const f=fixture();f.input.down(f.e());f.input.move(f.e({buttons:3}));
  f.input.lost(f.e());f.input.cancel();f.input.up(f.e({buttons:0}));
  assert.deepEqual(f.sent.filter(m=>m.e==='down').map(m=>m.b),[0,2]);
  assert.deepEqual(f.sent.filter(m=>m.e==='up').map(m=>m.b),[0,2]);
});
test('letterbox presses and other touch pointers cannot steal an active drag',()=>{
  const f=fixture();assert.equal(f.input.down(f.e({x:-0.1})),false);
  f.input.down(f.e());assert.equal(f.input.down(f.e({pointerId:2,isPrimary:false})),false);
  f.input.move(f.e({pointerId:2,x:0.9}));f.input.up(f.e({pointerId:2}));
  assert.equal(f.sent.length,1);f.input.up(f.e());assert.equal(f.sent.at(-1).e,'up');
});
test('reconnect never replays old button presses or releases',()=>{
  const f=fixture();f.input.down(f.e());f.unpair();f.pair();f.input.up(f.e());
  assert.equal(f.sent.length,1);f.input.down(f.e());f.input.up(f.e());assert.equal(f.sent.length,3);
});
test('observed button release recovers when pointerup was lost and hover never adopts a held external button',()=>{
  const f=fixture();f.input.move(f.e({buttons:1}));assert.equal(f.sent[0].b,0);
  f.input.down(f.e());f.input.move(f.e({buttons:0}));f.input.up(f.e({buttons:0}));
  assert.equal(f.sent.filter(m=>m.e==='up').length,1);
});
test('nonfinite release coordinates still release at the last valid position',()=>{
  const f=fixture();f.input.down(f.e({button:2,buttons:2}));f.input.up(f.e({x:NaN,y:Infinity}));
  assert.deepEqual(f.sent.at(-1),{t:'pointer',e:'up',x:0.5,y:0.5,b:2});
});

test('unsupported extra mouse buttons never become a native left click',()=>{
  const f=fixture();
  for(const button of [3,4])assert.equal(f.input.down(f.e({button,buttons:button===3?8:16})),false);
  assert.equal(f.sent.length,0);
  f.input.down(f.e());f.input.move(f.e({buttons:25}));f.input.cancel();
  assert.deepEqual(f.sent.filter(m=>m.e==='down').map(m=>m.b),[0]);
  assert.deepEqual(f.sent.filter(m=>m.e==='up').map(m=>m.b),[0]);
  assert.equal(f.sent.find(m=>m.e==='move').b,1);
});
