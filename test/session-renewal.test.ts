import { env, SELF, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { browserJoinPath, agentJoinPath } from '../src/joins';

async function setup(paired = true) {
  const sessionId = crypto.randomUUID(), browserToken = crypto.randomUUID(), agentToken = crypto.randomUUID();
  const stub = env.Session.getByName(sessionId);
  const minted = await stub.mint({sessionId,browserToken,agentToken,ttlSeconds:900});
  const sockets: WebSocket[] = [];
  if (paired) for (const path of [browserJoinPath(sessionId,browserToken),agentJoinPath(sessionId,agentToken)]) {
    const response = await SELF.fetch('https://example.com'+path,{headers:{Upgrade:'websocket'}});
    expect(response.status).toBe(101); response.webSocket!.accept(); sockets.push(response.webSocket!);
  }
  const issuedAt = Date.now();
  return {stub,sockets,input:{sessionId,requestId:crypto.randomUUID(),revision:1,
    previousExpiresAt:minted.expiresAt,expiresAt:issuedAt+3_600_000,issuedAt},
    async close(){ await stub.endOwnedSession(browserToken); }};
}
it('commits exact renewal once, survives eviction and ignores old alarm', async()=>{
  const s=await setup();
  try {
    expect(await s.stub.commitRenewal(s.input)).toBe(true);
    await evictDurableObject(s.stub);
    expect(await s.stub.commitRenewal(s.input)).toBe(true);
    expect((await s.stub.status())?.expiresAt).toBe(s.input.expiresAt);
    expect((await s.stub.readOriginalAuthorizationContext())?.expiresAt).toBe(s.input.previousExpiresAt);
    await runInDurableObject(s.stub,async(instance,state)=>{
      await instance.onAlarm(); expect(await state.storage.getAlarm()).toBe(s.input.expiresAt);
    });
    expect(await s.stub.status()).not.toBeNull();
    expect(await s.stub.commitRenewal({...s.input,requestId:crypto.randomUUID()})).toBe(false);
  } finally { await s.close(); }
});
it('rejects wrong session, skipped revision, stale expiry and overlong extension',async()=>{
  const s=await setup();
  try {
    for(const change of [{sessionId:'other'},{revision:2},{previousExpiresAt:s.input.previousExpiresAt+1},
      {expiresAt:s.input.expiresAt+1},{requestId:'invalid'}])
      expect(await s.stub.commitRenewal({...s.input,...change})).toBe(false);
    expect((await s.stub.status())?.expiresAt).toBe(s.input.previousExpiresAt);
  } finally {await s.close();}
});
it('cannot renew unpaired or expired sessions',async()=>{
  const unpaired=await setup(false);
  try {expect(await unpaired.stub.commitRenewal(unpaired.input)).toBe(false);}finally{await unpaired.close();}
  const s=await setup();
  try {
    await runInDurableObject(s.stub,(_instance,state)=>state.storage.sql.exec('UPDATE session SET expires_at = ?',Date.now()-1));
    expect(await s.stub.commitRenewal(s.input)).toBe(false);
  }finally{await s.close();}
});
