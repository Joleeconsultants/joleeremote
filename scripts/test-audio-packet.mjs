import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAacPacket} from '../public/audio-packet.js';
const base={v:1,generation:'a'.repeat(32),sequence:0,codec:'mp4a.40.2',sampleRate:48000,
  channels:2,description:'EZA=',targetBitrate:128000,timestampUs:0,durationUs:21333};
function packet(change={},size=10){const h=new TextEncoder().encode(JSON.stringify({...base,...change}));
  const b=new Uint8Array(8+h.length+size);b.set([74,82,65,49]);new DataView(b.buffer).setUint32(4,h.length,true);b.set(h,8);return b;}
test('validates AAC config and preserves access unit bytes',()=>{
  const p=parseAacPacket(packet());assert.equal(p.data.length,10);assert.deepEqual([...p.config.description],[17,144]);
  assert.equal(parseAacPacket(packet({sequence:1,timestampUs:21333,durationUs:21333})).header.sequence,1);
  assert.equal(parseAacPacket(packet({sequence:2,timestampUs:42666,durationUs:21334})).header.durationUs,21334);
});
test('rejects inconsistent config, malformed timing and oversized packets',()=>{
  for(const change of [{channels:1},{sampleRate:24000},{description:'AAAA'},{generation:'A'.repeat(32)},
    {sequence:-1},{timestampUs:1},{durationUs:21334},{targetBitrate:1},{v:2}])
    assert.throws(()=>parseAacPacket(packet(change)));
  assert.throws(()=>parseAacPacket(packet({},8193)));assert.throws(()=>parseAacPacket(packet({},0)));
  const b=packet();new DataView(b.buffer).setUint32(4,1025,true);assert.throws(()=>parseAacPacket(b));
});
