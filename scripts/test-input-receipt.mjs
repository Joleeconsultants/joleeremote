import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
test('shortcut buttons send one paired down/up and cannot replay or release an already held key',()=>{
  const sent=[];
  const c=vm.createContext({sessionPaired:true,heldViewerKeys:new Map(),sendInput:m=>sent.push({...m})});
  vm.runInContext(html.slice(html.indexOf('function sendShortcutKey('),html.indexOf('canvas.addEventListener("keydown"')),c);
  c.sendShortcutKey('Escape');c.sendShortcutKey('F11');
  assert.deepEqual(sent.map(m=>[m.key,m.code,m.e]),[['Escape','Escape','down'],['Escape','Escape','up'],['F11','F11','down'],['F11','F11','up']]);
  c.sendShortcutKey('Delete');c.heldViewerKeys.set('F11',{});c.sendShortcutKey('F11');c.sessionPaired=false;c.sendShortcutKey('Escape');
  assert.equal(sent.length,4);
});
function fixture(){
  const canvas={dataset:{}};
  const c=vm.createContext({canvas});
  vm.runInContext(html.slice(html.indexOf('function consumeInputResult('),html.indexOf('function printFromFrame(')),c);
  return {canvas,consume:c.consumeInputResult};
}
test('native rejection survives frame handling without exposing input contents',()=>{
  const f=fixture();
  assert.equal(f.consume({type:'input_result',status:'rejected',code:'input_failed',requested:2,submitted:0,key:'secret',x:0.5}),true);
  assert.deepEqual(JSON.parse(f.canvas.dataset.inputReceipt),{status:'rejected',code:'input_failed',requested:2,submitted:0});
});
test('unrelated and malformed packets do not replace bounded evidence',()=>{
  const f=fixture();
  assert.equal(f.consume({type:'stats'}),false);
  for(const extra of [{code:'arbitrary'},{requested:-1},{submitted:NaN},{status:'submitted'}]){
    assert.equal(f.consume({type:'input_result',status:'rejected',code:'input_failed',requested:2,submitted:0,...extra}),true);
    assert.equal(f.canvas.dataset.inputReceipt,undefined);
  }
});
