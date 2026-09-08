import { env, SELF, runInDurableObject, evictDurableObject } from "cloudflare:test";
import type { Session } from "../src/session";
import { expect, it } from "vitest";
function input(context: string | null = "private-context") { return {sessionId:crypto.randomUUID(),browserToken:crypto.randomUUID(),agentToken:crypto.randomUUID(),ttlSeconds:900,mintContext:context}; }
async function attempt(stub: DurableObjectStub<Session>, value: ReturnType<typeof input>) {
 return runInDurableObject(stub,async(instance:Session)=>{try{return {ok:true,value:await instance.mint(value)};}catch(e){return {ok:false,error:String(e)};}});
}
it("seals context with the session, survives eviction and keeps public status private", async()=>{
 const value=input(),stub=env.Session.getByName(value.sessionId);const first=await stub.mint(value);
 expect(await stub.readMintContext()).toEqual({sessionId:value.sessionId,expiresAt:first.expiresAt,context:value.mintContext});
 expect(await stub.mint(value)).toEqual(first);
 await evictDurableObject(stub);
 expect((await stub.readMintContext())?.context).toBe(value.mintContext);
 const status=await SELF.fetch(`https://example.com/sessions/${value.sessionId}`);
 expect(await status.text()).not.toContain(value.mintContext);
 for(const change of [{mintContext:"other"},{browserToken:"different"},{agentToken:"different"},{ttlSeconds:901},{sessionId:"different"}])
  expect((await attempt(stub,{...value,...change})).ok).toBe(false);
 expect((await stub.readMintContext())?.expiresAt).toBe(first.expiresAt);
});
it("null and legacy contexts cannot be upgraded",async()=>{
 const value=input(null),stub=env.Session.getByName(value.sessionId);await stub.mint(value);
 expect((await attempt(stub,{...value,mintContext:"upgrade"})).ok).toBe(false);
 await runInDurableObject(stub,(_instance,state)=>{state.storage.sql.exec("DELETE FROM session_mint_context");});
 expect((await stub.readMintContext())?.context).toBeNull();
 expect((await attempt(stub,{...value,mintContext:"upgrade"})).ok).toBe(false);
 expect((await attempt(stub,value)).ok).toBe(false);
});
it("context insertion failure rolls back the entire mint",async()=>{
 const value=input(),stub=env.Session.getByName(value.sessionId);
 await runInDurableObject(stub,(_instance,state)=>{state.storage.sql.exec("CREATE TRIGGER fail_context BEFORE INSERT ON session_mint_context BEGIN SELECT RAISE(ABORT, 'test failure'); END");});
 expect((await attempt(stub,value)).ok).toBe(false);expect(await stub.status()).toBeNull();expect(await stub.readMintContext()).toBeNull();
 await runInDurableObject(stub,(_instance,state)=>{state.storage.sql.exec("DROP TRIGGER fail_context");});
 await stub.mint(value);expect((await stub.readMintContext())?.context).toBe(value.mintContext);
});
it("concurrent conflicting mints leave one complete immutable result",async()=>{
 const value=input(),stub=env.Session.getByName(value.sessionId);
 const results=await Promise.all([attempt(stub,value),attempt(stub,{...value,mintContext:"conflict"})]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);
 expect([value.mintContext,"conflict"]).toContain((await stub.readMintContext())?.context);
});
it("bounds context by UTF8 bytes and never accepts HTTP body context",async()=>{
 const value=input("é".repeat(4097)),stub=env.Session.getByName(value.sessionId);
 expect((await attempt(stub,value)).error).toContain("invalid mint context");expect(await stub.status()).toBeNull();
 const res=await SELF.fetch("https://example.com/sessions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mintContext:"forged"})});
 expect(res.status).toBe(201);const minted=await res.json() as {sessionId:string};
 expect((await env.Session.getByName(minted.sessionId).readMintContext())?.context).toBeNull();
});
it("expired context is unavailable",async()=>{
 const value=input(),stub=env.Session.getByName(value.sessionId);await stub.mint(value);
 await runInDurableObject(stub,(_instance,state)=>{state.storage.sql.exec("UPDATE session SET expires_at = ?",Date.now()-1);});
 expect(await stub.readMintContext()).toBeNull();expect((await attempt(stub,value)).ok).toBe(false);
});
