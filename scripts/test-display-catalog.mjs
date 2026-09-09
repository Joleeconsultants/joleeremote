import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readDisplayCatalog,resolutionChoices} from '../public/display-catalog.js';
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
  const c=vm.createContext({pendingScreenRequest:null,crypto:{randomUUID:()=> 'request'},setTimeout:()=>1,
    finishScreenRequest:(...args)=>{results.push(args);c.pendingScreenRequest=null;},
    sessionPaired:true,performance:{now:()=>100},agentStatsReceivedAt:90,agentScreen:{catalog},readDisplayCatalog,
    screenUseCssScaling:true,innerWidth:1365,innerHeight:767,devicePixelRatio:2,
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
});
