import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionState} from '../public/session-state.js';
test('reconnect requires a new painted frame before dismissing the stale-screen notice',()=>{
  let shown;const s=new SessionState(value=>shown=value);
  s.set('paired');assert.equal(shown.visible,true);
  s.frame();assert.equal(shown.visible,false);
  s.set('disconnected');assert.equal(shown.visible,true);assert.match(shown.text,/not live/);
  s.frame();assert.equal(shown.visible,true);
  s.set('paired');assert.equal(shown.visible,true);
  s.frame();assert.equal(shown.visible,false);
});
test('terminal state stays visible despite delayed old frames',()=>{
  for(const state of ['ended','expired','unavailable']){
    let shown;const s=new SessionState(value=>shown=value);s.set('paired');s.frame();
    s.set(state);s.frame();assert.equal(shown.state,state);assert.equal(shown.visible,true);assert.equal(shown.terminal,true);
  }
});

test('known expiry wins before a waiting or reconnecting banner is rendered',()=>{
  const seen=[];const s=new SessionState(v=>seen.push(v.state));
  s.set('paired',Date.now()-1,'session');
  s.set('waiting');s.set('disconnected');s.set('paired');s.frame();
  assert.deepEqual(seen,['connecting','expired']);
  s.set('paired',Date.now()+60000,'new-session');s.frame();
  assert.equal(seen.at(-1),'paired');
});
test('terminal close is not overwritten by delayed connection events',()=>{
  for(const terminal of ['ended','expired','unavailable']){
    let shown;const s=new SessionState(v=>shown=v);
    s.set(terminal,null,'session');
    for(const state of ['waiting','disconnected','paired'])assert.equal(s.set(state),terminal);
    assert.equal(shown.state,terminal);
  }
});
