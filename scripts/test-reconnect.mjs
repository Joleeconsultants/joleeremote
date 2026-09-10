import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
function fixture(){
 const states=[];const sockets=[];
 class Socket{constructor(opts){this.opts=opts;this.events={};sockets.push(this);}addEventListener(n,fn){this.events[n]=fn;}close(){this.closed=true;}}
 const c=vm.createContext({session:'same-session',token:'same-token',hop:'example.test',socket:null,PartySocket:Socket,URL,location:{host:'example.test',href:'https://example.test/'},history:{replaceState(){}},setStatus:s=>states.push(s),stopAudioPlayback(){},stopMicrophone(){},stopWebcam(){}});
 const code=html.slice(html.indexOf('function disconnect(){'),html.indexOf('  currentSocket.addEventListener("message",'))+'return currentSocket;}';vm.runInContext(code,c);return {c,states,sockets};
}
test('ordinary disconnect retries in place without replacing session credentials',()=>{
 const {c,states,sockets}=fixture();const s=c.connect();assert.equal(s.opts.maxRetries,Infinity);assert.equal(s.opts.minReconnectionDelay,5000);assert.equal(s.opts.maxReconnectionDelay,5000);
 s.events.close({code:1006});assert.equal(s.closed,undefined);assert.equal(states.at(-1),'disconnected');s.events.open();assert.equal(states.at(-1),'waiting');assert.equal(sockets.length,1);assert.equal(s.opts.room,'same-session');assert.equal(s.opts.query.token,'same-token');
});
test('terminal close stops transport instead of retrying credentials or eviction',()=>{
 for(const code of [4000,4001,4002,4003,4004,4009,4010]){const {c,states}=fixture();const s=c.connect();s.events.close({code});assert.equal(s.closed,true);assert.equal(c.socket,null);assert.equal(states.at(-1),code===4010?'expired':code===4000?'ended':'unavailable');}
});
test('the lifetime timer closes reconnecting transport on expiry',()=>{
 const {c,states}=fixture();const s=c.connect();c.queueMicrotask=fn=>fn();
 const callback=html.match(/onExpired:(\(\)=>queueMicrotask\(\(\)=>\{disconnect\(\);setStatus\('expired'\);\}\))/)[1];vm.runInContext('('+callback+')()',c);assert.equal(s.closed,true);assert.equal(c.socket,null);assert.equal(states.at(-1),'expired');
});
