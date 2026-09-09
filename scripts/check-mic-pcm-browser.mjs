import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const worklet=await readFile(new URL('../public/mic-pcm-worklet.js',import.meta.url));
const server=createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/mic-pcm-worklet.js'?'text/javascript':'text/html');
  res.end(req.url==='/mic-pcm-worklet.js'?worklet:'<!doctype html><title>Silent PCM fixture</title>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER_CHANNEL?{channel:process.env.DASHBOARD_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await page.evaluate(async()=>{
    const context=new AudioContext({sampleRate:48000});
    let oscillator,node;
    try{
      await context.audioWorklet.addModule('/mic-pcm-worklet.js');
      node=new AudioWorkletNode(context,'jolee-mic-pcm');
      oscillator=context.createOscillator();oscillator.frequency.value=660;
      oscillator.connect(node);node.connect(context.destination); // Worklet output is always silent.
      const samples=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('No PCM frames from worklet')),5000);
        const blocks=[];
        node.port.onmessage=e=>{
          const {buffer,sequence}=e.data;const view=new DataView(buffer);let peak=0;
          for(let i=0;i<view.byteLength;i+=2)peak=Math.max(peak,Math.abs(view.getInt16(i,true)));
          blocks.push({bytes:buffer.byteLength,sequence,peak});node.port.postMessage({ack:sequence});
          if(blocks.length===3){clearTimeout(timer);resolve(blocks);}
        };
      });
      oscillator.start();await context.resume();return await samples;
    }finally{oscillator?.stop();oscillator?.disconnect();node?.disconnect();await context.close();}
  });
  assert.equal(result.length,3);assert.ok(result.every(b=>b.bytes===2400&&b.peak>1000));
  assert.ok(result.every((b,i)=>i===0||b.sequence>result[i-1].sequence));
  console.log('Real browser AudioWorklet PCM framing/resampling PASS; synthetic source, silent output, no microphone or PC session.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
