import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USE_BROWSER_CURSORS_SPEC, resolveSpec } from '../chrome/selkies-dashboard/src/jolee-shims/conditional-settings.js';
const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
function fixture(){
  const c=vm.createContext({Uint8Array,DataView,atob,Number,parseJsonFrameObject:x=>x,
    canvas:{style:{}},cursorEl:{style:{},src:'fallback'},stage:{addEventListener(){},getBoundingClientRect:()=>({left:10,top:20})},
    useBrowserCursors:false,nativeCursor:'default',pointerOver:true,agentCursorVisible:true,cursorHx:1,cursorHy:1,cursorPosition:null,
    DEFAULT_CURSOR_SVG:'fallback',DEFAULT_CURSOR_HX:1,DEFAULT_CURSOR_HY:1});
  vm.runInContext(html.slice(html.indexOf('function applyCursorMode('),html.indexOf('let sessionPaired='))+
    html.slice(html.indexOf('function cursorFromFrame('),html.indexOf('function contentBox('))+
    html.slice(html.indexOf('function moveOverlay('),html.indexOf('// Each native generation')),c);
  return c;
}
// A PNG header fixture suffices for parser geometry; actual browser decoding is separate.
function cursor(width=32,height=32,hx=2,hy=3){
  const p=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(p);p.writeUInt32BE(13,8);p.write('IHDR',12);
  p.writeUInt32BE(width,16);p.writeUInt32BE(height,20);
  return {t:'cursor',visible:true,mime:'image/png',data:p.toString('base64'),hx,hy};
}
test('cursor accepts bounded PNG geometry and rejects invalid hotspots or arbitrary URLs',()=>{
  const f=fixture(); assert.ok(f.cursorFromFrame(cursor()));
  for(const c of [cursor(129),cursor(0),cursor(32,32,32),cursor(32,32,0,-1),cursor(32,32,0.5),
    {...cursor(),mime:'image/svg+xml'},{...cursor(),data:'https://example.invalid'},
    {...cursor(),data:'AAAA'},{...cursor(),data:'A'.repeat(174765)},{...cursor(),visible:1}])assert.equal(f.cursorFromFrame(c),null);
});
test('native mode uses local cursor types while drawn mode retains remote shape and hotspot',()=>{
  const f=fixture(),shape=f.cursorFromFrame({...cursor(),css:'text'});f.applyCursorFrame(shape);
  assert.equal(f.cursorEl.style.display,'block');assert.equal(f.canvas.style.cursor,'none');
  f.useBrowserCursors=true;f.applyCursorMode();
  assert.equal(f.canvas.style.cursor,'text');assert.match(f.cursorEl.src,/^data:image\/png;base64,/);
  assert.equal(f.cursorEl.style.display,'none');
  f.applyCursorFrame(f.cursorFromFrame({t:'cursor',visible:false}));assert.equal(f.canvas.style.cursor,'none');
  f.applyCursorFrame(f.cursorFromFrame({t:'cursor',visible:true}));assert.equal(f.canvas.style.cursor,'text');
  f.applyCursorFrame(f.cursorFromFrame({t:'cursor',visible:false}));
  f.useBrowserCursors=false;f.applyCursorMode();assert.equal(f.cursorEl.style.display,'none');
});

test('unknown or missing native type falls back to local arrow and never remote CSS',()=>{
  const f=fixture();f.useBrowserCursors=true;
  for(const css of [undefined,'url(https://example.invalid/cursor), auto','inherit',{},'']){
    f.applyCursorFrame(f.cursorFromFrame({...cursor(),css}));assert.equal(f.canvas.style.cursor,'default');
  }
  for(const css of ['pointer','wait','progress','crosshair','move','not-allowed','help','ew-resize','ns-resize','nesw-resize','nwse-resize']){
    f.applyCursorFrame(f.cursorFromFrame({...cursor(),css}));assert.equal(f.canvas.style.cursor,css);
  }
  f.resetRemoteCursor();assert.equal(f.canvas.style.cursor,'default');
});

test('drawn cursor remains at the touch location after lift but hides on mouse leave or blur',()=>{
  const f=fixture();f.moveOverlay({clientX:100,clientY:80});f.applyCursorFrame(f.cursorFromFrame(cursor()));
  const location=f.cursorEl.style.transform;
  f.leaveCursor({pointerType:'touch'});assert.equal(f.cursorEl.style.display,'block');assert.equal(f.cursorEl.style.transform,location);
  f.hideDrawnCursor();assert.equal(f.cursorEl.style.display,'none');
  f.pointerOver=true;f.leaveCursor({pointerType:'mouse'});assert.equal(f.cursorEl.style.display,'none');
});

test('cursor defaults select drawn on desktop and mobile without overriding saved choices',()=>{
  for(const mobileClient of [true,false]){
    assert.equal(resolveSpec(USE_BROWSER_CURSORS_SPEC,null,{mobileClient},()=>null),false);
    for(const value of [true,false])assert.equal(resolveSpec(USE_BROWSER_CURSORS_SPEC,null,{mobileClient},()=>String(value)),value);
  }
  assert.equal(resolveSpec(USE_BROWSER_CURSORS_SPEC,{use_browser_cursors:{locked:true,value:false}},{mobileClient:false},()=> 'true'),false);
});
test('a stationary pointer updates its hotspot and session reset clears the old remote shape',()=>{
  const f=fixture();f.moveOverlay({clientX:100,clientY:80});f.applyCursorFrame(f.cursorFromFrame(cursor(32,32,10,12)));
  assert.equal(f.cursorEl.style.transform,'translate(80px,48px)');
  f.resetRemoteCursor();assert.equal(f.cursorEl.src,'fallback');assert.equal(f.cursorHx,1);assert.equal(f.cursorPosition,null);
});
