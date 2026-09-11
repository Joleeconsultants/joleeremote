import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readDisplayCatalog,resolutionChoices,publishScreenDiagnostic} from '../public/display-catalog.js';
import {DisplayTransition} from '../public/display-transition.js';
const id = n => n.toString(16).padStart(32,'0');
const mode=(n,width,height,refresh_hz=60,selectable=true)=>({id:id(n),width,height,refresh_hz,selectable,reason:selectable?null:'capture_limit'});
const display={id:id(1),label:'Left monitor',primary:false,x:-1920,y:0,width:1920,height:1080,
  current_mode_id:id(2),can_resize:true,reason:null,modes:[mode(2,1920,1080),mode(3,1920,1080,75),mode(4,1280,720),mode(5,7680,4320,60,false)]};
const catalog={revision:id(9),selected_display_id:id(1),displays:[display]};
test('catalog preserves negative origins, disabled Windows modes and preferred refresh',()=>{
  assert.equal(readDisplayCatalog(catalog),catalog);
  assert.equal(readDisplayCatalog({...catalog,selected_display_id:null})?.selected_display_id,null);
  const choices=resolutionChoices(display);
  assert.equal(choices.length,3);
  assert.equal(choices[1].mode.id,id(2));
  assert.equal(choices[1].current,true);
  assert.equal(choices[2].mode.selectable,false);
  for(const bad of [null,{...catalog,selected_display_id:id(99)},{...catalog,displays:[display,display]},
    {...catalog,displays:[{...display,current_mode_id:id(99)}]},
    {...catalog,displays:[{...display,modes:[{...mode(2,1920,1080),selectable:'true'}]}]}]) assert.equal(readDisplayCatalog(bad),null);
});
test('actual viewer sends exact catalog modes, rejects stale catalog and does not align supported sizes',()=>{
  const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
  const sent=[],results=[];
  const c=vm.createContext({microphoneFeatureEnabled:false,pendingScreenRequest:null,crypto:{randomUUID:()=> 'request'},setTimeout:()=>1,
    finishScreenRequest:(...args)=>{results.push(args);c.pendingScreenRequest=null;},
    sessionPaired:true,performance:{now:()=>100},agentStatsReceivedAt:90,agentScreen:{catalog},readDisplayCatalog,
    screenUseCssScaling:true,innerWidth:1365,innerHeight:767,devicePixelRatio:2,
    pointerInput:{cancel(){}},heldViewerKeys:new Map(),clipboardPaste:{reset(){}},hideDrawnCursor(){},
    displayTransition:new DisplayTransition(),sessionState:{stale(){}},
    screenAutoEnabled:true,scheduleScreenResize(){},sendInput:payload=>sent.push(payload)});
  vm.runInContext(html.slice(html.indexOf('function requestCatalogDisplay('),html.indexOf('function scheduleScreenResize(')),c);
  c.requestCatalogDisplay({type:'setDisplayMode',display_id:id(1),catalog_revision:id(9),mode_id:id(4)});
  assert.equal(sent[0].w,1280);assert.equal(sent[0].mode_id,id(4));assert.equal(sent[0].request_id,'request');
  c.pendingScreenRequest=null;
  c.requestCatalogDisplay({type:'setBestFit',display_id:id(1),catalog_revision:id(9)});
  assert.equal(sent[1].w,1365);assert.equal(sent[1].h,767);assert.equal(sent[1].mode,'best_fit');
  c.pendingScreenRequest=null;
  c.requestCatalogDisplay({type:'setBestFit',display_id:id(1),catalog_revision:id(8)});
  assert.equal(results.at(-1)[1],'catalog_changed');assert.equal(sent.length,2);
  c.requestCatalogDisplay({type:'setDisplayMode',display_id:id(1),catalog_revision:id(9),mode_id:id(5)});
  assert.equal(results.at(-1)[1],'unsupported_mode');assert.equal(sent.length,2);
  c.requestCatalogDisplay({type:'setBestFit',display_id:id(1),catalog_revision:id(9),use_css_scaling:false});
  assert.equal(sent[2].w,2730);assert.equal(sent[2].h,1534);
  c.pendingScreenRequest=null;
  c.requestCatalogDisplay({type:'setBestFit',display_id:id(1),catalog_revision:id(9),use_css_scaling:true});
  assert.equal(sent[3].w,1365);assert.equal(sent[3].h,767);
});
test('display input guard requires matched acknowledgement then fresh paint; timeout never unlocks input',()=>{
  const guard=new DisplayTransition();
  guard.begin('one');
  assert.equal(guard.painted(),false);
  assert.equal(guard.acknowledge('stale'),false);
  for(const t of ['pointer','key','wheel','clipboard_paste','command'])assert.equal(guard.allows({t}),false);
  assert.equal(guard.allows({t:'resize'}),true);
  assert.equal(guard.acknowledge('one'),true);
  assert.equal(guard.blocked,true);
  assert.equal(guard.painted(),true);
  assert.equal(guard.blocked,false);
  guard.begin('two');guard.fail('two');
  assert.equal(guard.painted(),false);assert.equal(guard.acknowledge('two'),false);
  assert.equal(guard.blocked,true);
  guard.begin('retry');guard.acknowledge('retry');guard.painted();assert.equal(guard.blocked,false);
});
test('actual viewer input boundary blocks queued physical input during display transition',()=>{
  const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
  const sent=[],guard=new DisplayTransition();
  const c=vm.createContext({microphoneFeatureEnabled:false,canvas:{dataset:{}},displayTransition:guard,heldViewerKeys:new Map(),clipboardPaste:{cancel(){}},
    socket:{readyState:1,send:value=>sent.push(JSON.parse(value))},encodeInput:JSON.stringify,MAX_ENVELOPE_BYTES:1048576});
  vm.runInContext(html.slice(html.indexOf('function sendInput('),html.indexOf('function requestFullscreen(')),c);
  c.sendInput({t:'key',e:'down',key:'Shift',code:'ShiftLeft'});
  assert.equal(c.heldViewerKeys.size,1);
  c.sendInput({t:'key',e:'up',key:'Shift',code:'ShiftLeft'});
  assert.equal(c.heldViewerKeys.size,0);
  guard.begin('change');c.sendInput({t:'pointer',e:'down',x:0.5,y:0.5,b:0});
  guard.acknowledge('change');c.sendInput({t:'key',e:'down',key:'a',code:'KeyA'});
  assert.equal(sent.length,2);
  guard.painted();c.sendInput({t:'key',e:'down',key:'a',code:'KeyA'});assert.equal(sent.length,3);
});

test('screen diagnostics distinguish received catalog from expired forwarding without leaking content',()=>{
  const screen={status:'idle',mode:'auto',effective:{width:1920,height:1200},catalog,
    token:'secret',clipboard:'private',request_id:'private',reason:'private'};
  const dataset={};
  publishScreenDiagnostic(dataset,screen,screen,true,12);
  const fresh=JSON.parse(dataset.screenDiagnostic);
  assert.equal(fresh.received.catalog_valid,true);
  assert.deepEqual(fresh.received,fresh.forwarded);
  assert.equal(fresh.received.selected.mode_count,display.modes.length);
  assert.ok(!dataset.screenDiagnostic.includes('private'));
  assert.ok(!dataset.screenDiagnostic.includes('secret'));
  assert.ok(!dataset.screenDiagnostic.includes(display.label));
  publishScreenDiagnostic(dataset,screen,null,true,5100);
  assert.equal(JSON.parse(dataset.screenDiagnostic).forwarded,null);
  assert.equal(JSON.parse(dataset.screenDiagnostic).received.catalog_valid,true);
  assert.equal(dataset.screenReceiptAgeMs,'5100');
  publishScreenDiagnostic(dataset,{...screen,catalog:{}},null,false,Infinity);
  const invalid=JSON.parse(dataset.screenDiagnostic);
  assert.equal(invalid.received.catalog_present,true);
  assert.equal(invalid.received.catalog_valid,false);
  assert.equal(dataset.screenReceiptAgeMs,'unknown');
  assert.ok(dataset.screenDiagnostic.length<2048);
});
test('unchanged screen diagnostics do not rewrite the snapshot on telemetry ticks',()=>{
  let writes=0;const dataset=new Proxy({}, {set(target,key,value){if(key==='screenDiagnostic')writes++;target[key]=value;return true;}});
  const screen={status:'idle',mode:'auto',catalog};
  publishScreenDiagnostic(dataset,screen,screen,true,0);
  publishScreenDiagnostic(dataset,structuredClone(screen),structuredClone(screen),true,1500);
  assert.equal(writes,1);
  assert.equal(dataset.screenReceiptAgeMs,'1500');
  publishScreenDiagnostic(dataset,null,null,false,60001);
  assert.equal(writes,2);
});
