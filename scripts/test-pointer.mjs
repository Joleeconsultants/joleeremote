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

// Exercise the shipped gesture block without changing the absolute helper slice.
function trackpadFixture(){
  const listeners={}, sent=[], posted=[];let now=0, timer=null;
  const c=vm.createContext({
    Array,Math,performance:{now:()=>now},setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{timer=null;},
    canvas:{style:{},focus(){},addEventListener:(type,fn)=>{listeners[type]=fn;}},
    window:{parent:{postMessage:m=>posted.push(m)},location:{origin:'https://example.test'},addEventListener(){}},
    stage:{getBoundingClientRect:()=>({left:0,top:0,width:1000,height:500})},
    contentBox:()=>({left:0,top:0,width:1000,height:500}),
    pointerNorm:p=>({x:p.clientX/1000,y:p.clientY/500}),cursorPosition:{clientX:400,clientY:200},
    pointerInput:{cancel(){}},sessionPaired:true,displayTransition:{blocked:false},
    pointerOver:false,moveOverlay:p=>{c.cursorPosition=p;},applyCursorMode(){},unlockAudioFromGesture(){},
    sendInput:m=>sent.push(JSON.parse(JSON.stringify(m))),
  });
  vm.runInContext(html.slice(html.indexOf('// Trackpad touch gestures'),html.indexOf('canvas.addEventListener("pointermove"')),c);
  c.setTouchInputMode('trackpad');
  const point=(id,x,y)=>({identifier:id,clientX:x,clientY:y});
  function fire(type,points,changed=points){listeners[type]({type,touches:points,changedTouches:changed,preventDefault(){}});}
  return {c,sent,posted,point,fire,advance:ms=>{now+=ms;},hold:()=>{now+=500;timer?.();}};
}
test('trackpad movement is relative, clamped, and taps click at the virtual cursor',()=>{
  const f=trackpadFixture(), p=f.point;
  f.fire('touchstart',[p(1,800,400)]);
  assert.equal(f.sent.length,0);
  f.fire('touchmove',[p(1,900,450)]);
  assert.deepEqual(f.sent[0],{t:'pointer',e:'move',x:0.525,y:0.525,b:0});
  f.fire('touchend',[],[p(1,900,450)]);
  assert.equal(f.sent.length,1);
  f.fire('touchstart',[p(1,100,100)]);f.fire('touchend',[],[p(1,100,100)]);
  assert.deepEqual(f.sent.slice(-2).map(m=>[m.e,m.b,m.x,m.y]),[['down',0,0.525,0.525],['up',0,0.525,0.525]]);
  f.fire('touchstart',[p(1,100,100)]);f.fire('touchmove',[p(1,2000,-2000)]);
  assert.deepEqual([f.sent.at(-1).x,f.sent.at(-1).y],[1,0]);
});
test('trackpad two-finger tap and long press each right-click once',()=>{
  const f=trackpadFixture(),p=f.point;
  f.fire('touchstart',[p(1,100,100)]);f.fire('touchstart',[p(1,100,100),p(2,200,100)]);
  f.fire('touchend',[p(1,100,100)],[p(2,200,100)]);f.fire('touchend',[],[p(1,100,100)]);
  f.fire('touchstart',[p(1,100,100)]);f.hold();f.fire('touchend',[],[p(1,100,100)]);
  assert.deepEqual(f.sent.map(m=>[m.e,m.b]),[['down',2],['up',2],['down',2],['up',2]]);
});
test('trackpad scroll emits wheel only; pinch emits no input and touch mode resets zoom',()=>{
  const f=trackpadFixture(),p=f.point;
  f.fire('touchstart',[p(1,100,100),p(2,200,100)]);
  f.fire('touchmove',[p(1,100,120),p(2,200,120)]);
  f.fire('touchend',[],[p(1,100,120),p(2,200,120)]);
  assert.deepEqual(f.sent,[{t:'wheel',dx:0,dy:-20,x:0.4,y:0.4}]);
  f.sent.length=0;
  f.fire('touchstart',[p(1,100,100),p(2,200,100)]);
  f.fire('touchmove',[p(1,80,100),p(2,220,100)]);
  f.fire('touchmove',[p(1,90,120),p(2,230,120)]);
  f.fire('touchend',[p(1,90,120)],[p(2,230,120)]);
  f.fire('touchmove',[p(1,100,150)]);f.fire('touchend',[],[p(1,100,150)]);
  assert.equal(f.sent.length,0);assert.match(f.c.canvas.style.transform,/scale\(1.4\)/);
  f.c.setTouchInputMode('touch');assert.equal(f.c.canvas.style.transform,'');
  assert.deepEqual(f.posted.map(m=>m.enabled),[true,false]);
});
test('cancelled, switched, or disconnected trackpad holds never click',()=>{
  for(const stop of ['cancel','mode','disconnect']){
    const f=trackpadFixture(),p=f.point;
    f.fire('touchstart',[p(1,100,100)]);
    if(stop==='cancel')f.fire('touchcancel',[],[p(1,100,100)]);
    if(stop==='mode')f.c.setTouchInputMode('touch');
    if(stop==='disconnect')f.c.sessionPaired=false;
    f.hold();f.fire('touchend',[],[p(1,100,100)]);
    assert.equal(f.sent.length,0);
  }
});

function orientFixture({touch=true,portrait=true}={}){
  let portraitState=portrait;
  const sent=[], posted=[];
  const c=vm.createContext({
    Array,Math,performance:{now:()=>0},setTimeout:()=>1,clearTimeout(){},
    canvas:{style:{},focus(){},addEventListener(){}},
    window:{parent:{postMessage:m=>posted.push(m)},location:{origin:'https://example.test'},addEventListener(){}},
    stage:{getBoundingClientRect:()=>({left:0,top:0,width:1000,height:500})},
    contentBox:()=>({left:0,top:0,width:1000,height:500}),
    pointerNorm:p=>({x:p.clientX/1000,y:p.clientY/500}),cursorPosition:{clientX:400,clientY:200},
    pointerInput:{cancel(){}},sessionPaired:true,displayTransition:{blocked:false},
    pointerOver:false,moveOverlay(){},applyCursorMode(){},unlockAudioFromGesture(){},
    sendInput:m=>sent.push(m),
    navigator:{maxTouchPoints:touch?5:0},
    matchMedia:q=>({matches:q.includes('orientation: portrait')?portraitState:q.includes('pointer: coarse')?touch:false}),
    innerHeight:portrait?800:400,innerWidth:portrait?400:800,
  });
  vm.runInContext(html.slice(html.indexOf('// Trackpad touch gestures'),html.indexOf('canvas.addEventListener("pointermove"')),c);
  const read=expr=>vm.runInContext(expr,c);
  return {
    c,posted,read,
    setPortrait(next){
      portraitState=next;
      c.innerHeight=next?800:400;c.innerWidth=next?400:800;
      c.syncTrackpadForOrientation();
    },
  };
}
test('touch portrait defaults trackpad on; landscape forces absolute and restores the session pref',()=>{
  const f=orientFixture({touch:true,portrait:true});
  f.c.syncTrackpadForOrientation();
  assert.equal(f.read('trackpadMode'),true);
  assert.equal(f.read('trackpadUserPref'),true);
  assert.equal(f.posted.at(-1).enabled,true);
  f.c.setTouchInputMode('touch');
  assert.equal(f.read('trackpadMode'),false);
  assert.equal(f.read('trackpadUserPref'),false);
  f.setPortrait(false);
  assert.equal(f.read('trackpadMode'),false);
  assert.equal(f.read('trackpadUserPref'),false);
  f.setPortrait(true);
  assert.equal(f.read('trackpadMode'),false);
  f.c.setTouchInputMode('trackpad');
  assert.equal(f.read('trackpadUserPref'),true);
  f.setPortrait(false);
  assert.equal(f.read('trackpadMode'),false);
  assert.equal(f.read('trackpadUserPref'),true);
  f.c.setTouchInputMode('trackpad');
  assert.equal(f.read('trackpadMode'),false);
  assert.equal(f.read('trackpadUserPref'),true);
  f.setPortrait(true);
  assert.equal(f.read('trackpadMode'),true);
});
test('non-touch clients do not auto-enable trackpad',()=>{
  const f=orientFixture({touch:false,portrait:true});
  f.c.syncTrackpadForOrientation();
  assert.equal(f.read('trackpadMode'),false);
  f.c.setTouchInputMode('trackpad');
  assert.equal(f.read('trackpadMode'),true);
});
