import {parseAacPacket} from './audio-packet.js';

/** Decodes only explicitly acknowledged AAC generations. Owns and closes AudioData. */
export class NegotiatedAudioDecoder {
  constructor({output,fallback,Decoder=globalThis.AudioDecoder,Chunk=globalThis.EncodedAudioChunk}) {
    Object.assign(this,{output,fallback,Decoder,Chunk});this.epoch=0;this.reset();
  }
  reset() {
    this.epoch++;try{this.decoder?.close();}catch{}
    this.decoder=null;this.generation=null;this.sequence=0;this.config=null;this.failed=false;
    this.pending=0;this.chain=Promise.resolve();
  }
  acknowledge(result) {
    this.reset();
    if (result?.status!=='applied' || result.codec!=='mp4a.40.2') return;
    if (!/^[a-f0-9]{32}$/.test(result.generation||'')) return this.fail();
    this.generation=result.generation;
    this.effective={sampleRate:result.sampleRate,channels:result.channels,targetBitrate:result.targetBitrate};
  }
  fail() {
    if (this.failed) return;
    this.reset();this.failed=true;this.fallback();
  }
  push(bytes) {
    const epoch=this.epoch;
    if(this.failed || !this.generation)return Promise.resolve();
    if(this.pending>=8){this.fail();return Promise.resolve();}
    this.pending++;
    const copy=bytes.slice();
    this.chain=this.chain.then(async()=>{
      if(epoch!==this.epoch)return;
      try{await this.decode(copy);}finally{if(epoch===this.epoch)this.pending--;}
    });
    return this.chain;
  }
  async decode(bytes) {
    const epoch=this.epoch;
    try {
      if (this.failed || !this.generation) return;
      const packet=parseAacPacket(bytes),h=packet.header;
      // Old-generation queued packets are harmless; never let them reconfigure playback.
      if(h.generation!==this.generation)return;
      if(h.sequence!==this.sequence || Object.entries(this.effective).some(([key,value])=>h[key]!==value))throw Error('audio_discontinuity');
      this.sequence++;
      if (!this.decoder) {
        if(this.config)throw Error('audio_configuration_pending');
        this.config=packet.config;
        if(!this.Decoder || !(await this.Decoder.isConfigSupported(packet.config)).supported)throw Error('audio_unsupported');
        if(epoch!==this.epoch)return;
        this.decoder=new this.Decoder({output:data=>{
          try{if(epoch===this.epoch)this.output(data);}finally{data.close();}
        },error:()=>{if(epoch===this.epoch)this.fail();}});
        this.decoder.configure(packet.config);
      }
      if(epoch!==this.epoch)return;
      if(this.decoder.decodeQueueSize>=8)throw Error('audio_backlog');
      this.decoder.decode(new this.Chunk({type:'key',timestamp:h.timestampUs,duration:h.durationUs,data:packet.data}));
    }catch{if(epoch===this.epoch)this.fail();}
  }
}
