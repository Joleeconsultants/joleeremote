import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
if (!process.argv[2]) throw Error('Provide the synthetic AAC fixture JSON path');
const fixture=JSON.parse(await readFile(process.argv[2],'utf8'));
if(fixture.packets){
  const parsed=fixture.packets.map(value=>{const b=Buffer.from(value,'base64'),n=b.readUInt32LE(4);
    return {header:JSON.parse(b.subarray(8,8+n).toString('utf8')),data:b.subarray(8+n).toString('base64')};});
  const h=parsed[0].header;
  Object.assign(fixture,{codec:h.codec,sampleRate:h.sampleRate,numberOfChannels:h.channels,description:h.description,
    frames:parsed.map(p=>({data:p.data,timestampUs:p.header.timestampUs,durationUs:p.header.durationUs})),
    acknowledgement:JSON.parse(fixture.controls.find(c=>JSON.parse(c).status==='applied'))});
}
const modules=new Map(await Promise.all(['audio-decoder.js','audio-packet.js'].map(async name=>
  ['/'+name,await readFile(new URL('../public/'+name,import.meta.url),'utf8')])));
const server=createServer((req,res)=>{
  res.setHeader('Content-Type',modules.has(req.url)?'text/javascript':'text/html');
  res.end(modules.get(req.url)||'<!doctype html><title>Silent AAC decode test</title>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,channel:process.env.DASHBOARD_BROWSER_CHANNEL||'msedge'});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async fixture=>{
    const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const config={codec:fixture.codec,sampleRate:fixture.sampleRate,numberOfChannels:fixture.numberOfChannels,
      description:bytes(fixture.description)};
    if (!(await AudioDecoder.isConfigSupported(config)).supported) return {supported:false};
    let frames=0,samples=0,error=null;
    const decoder=new AudioDecoder({output:data=>{frames++;samples+=data.numberOfFrames;data.close();},error:e=>{error=e.message;}});
    try {
      decoder.configure(config);
      for(const f of fixture.frames) decoder.decode(new EncodedAudioChunk({type:'key',timestamp:f.timestampUs,duration:f.durationUs,data:bytes(f.data)}));
      await decoder.flush();return {supported:true,frames,samples,error};
    }finally{decoder.close();}
  },fixture);
  assert.equal(result.supported,true);assert.equal(result.error,null);
  assert.equal(result.frames,fixture.frames.length);assert.ok(result.samples>0);
  const receiver=await page.evaluate(async fixture=>{
    const {NegotiatedAudioDecoder}=await import('/audio-decoder.js');
    let frames=0,fallbacks=0;
    const player=new NegotiatedAudioDecoder({output:()=>frames++,fallback:()=>fallbacks++});
    const generation='a'.repeat(32);
    const ack=fixture.acknowledgement||{status:'applied',codec:fixture.codec,generation,sampleRate:fixture.sampleRate,
      channels:fixture.numberOfChannels,targetBitrate:128000};
    const packet=(frame,sequence)=>{
      if(fixture.packets)return Uint8Array.from(atob(fixture.packets[sequence]),c=>c.charCodeAt(0));
      const h=new TextEncoder().encode(JSON.stringify({v:1,...ack,description:fixture.description,
        sequence,timestampUs:frame.timestampUs,durationUs:frame.durationUs}));
      const data=Uint8Array.from(atob(frame.data),c=>c.charCodeAt(0));
      const result=new Uint8Array(8+h.length+data.length);result.set([74,82,65,49]);
      new DataView(result.buffer).setUint32(4,h.length,true);result.set(h,8);result.set(data,8+h.length);return result;
    };
    try{
      player.acknowledge(ack);
      for(let i=0;i<fixture.frames.length;i++){
        await player.push(packet(fixture.frames[i],i));
        if(player.decoder)await player.decoder.flush();
      }
      const decoded=frames;
      await player.push(packet(fixture.frames[0],0)); // sequence regression must request PCM once
      await player.push(packet(fixture.frames[0],0));
      player.reset();
      await player.push(packet(fixture.frames[0],0));
      const afterReset=frames;
      player.acknowledge(ack);
      await player.push(packet(fixture.frames[0],0));
      await player.decoder.flush();
      return {decoded,fallbacks,afterReset,restarted:frames-afterReset};
    }finally{player.reset();}
  },fixture);
  assert.equal(receiver.decoded,fixture.frames.length);assert.equal(receiver.fallbacks,1);
  assert.equal(receiver.afterReset,receiver.decoded);assert.equal(receiver.restarted,1);
  console.log(JSON.stringify({receiver}));
  console.log(JSON.stringify({result,output:'Decoded and discarded; no AudioContext, playback or devices.'}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
