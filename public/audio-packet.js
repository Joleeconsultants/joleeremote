// Negotiated AAC transport only. Legacy WAV takes its existing playback path.
const asc = new Map([[44100, ['Egg=', 'EhA=']], [48000, ['EYg=', 'EZA=']]]);
export function aacConfig(value) {
  if (!value || value.codec !== 'mp4a.40.2' || ![1,2].includes(value.channels) ||
      asc.get(value.sampleRate)?.[value.channels-1] !== value.description) throw Error('invalid_audio_config');
  return {codec:value.codec,sampleRate:value.sampleRate,numberOfChannels:value.channels,
    description:Uint8Array.from(atob(value.description), c=>c.charCodeAt(0))};
}
export function parseAacPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 9 || bytes.length > 8+1024+8192 ||
      bytes[0]!==74 || bytes[1]!==82 || bytes[2]!==65 || bytes[3]!==49) throw Error('invalid_audio_packet');
  const length = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true);
  if (!length || length>1024 || bytes.length<=8+length || bytes.length-8-length>8192) throw Error('invalid_audio_length');
  const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(8,8+length)));
  if (!header || header.v!==1 || typeof header.generation!=='string' || !/^[a-f0-9]{32}$/.test(header.generation) ||
      ![header.sequence,header.timestampUs,header.durationUs].every(Number.isSafeInteger) ||
      header.sequence<0 || header.timestampUs<0 || header.durationUs<=0 ||
      ![96000,128000,160000,192000].includes(header.targetBitrate)) throw Error('invalid_audio_header');
  const config=aacConfig(header);
  const start=Math.floor(header.sequence*1024*1_000_000/header.sampleRate);
  const end=Math.floor((header.sequence+1)*1024*1_000_000/header.sampleRate);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || header.timestampUs!==start || header.durationUs!==end-start)
    throw Error('invalid_audio_timing');
  return {header,config,data:bytes.slice(8+length)};
}
