import {aacConfig} from './audio-packet.js';
const generation=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
/** Connection owner resets this on unpair. Only matched acknowledgements change effective state. */
export class AudioControl {
  constructor({send,applied,changed,Decoder=globalThis.AudioDecoder,makeId=()=>crypto.randomUUID(),
    schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}) {
    Object.assign(this,{send,applied,changed,Decoder,makeId,schedule,unschedule});this.epoch=0;this.reset();
  }
  clearPending(){this.unschedule(this.timer);this.timer=null;this.pending=null;}
  reset(){this.epoch++;this.capability=null;this.clearPending();this.queued=null;this.active=null;this.choices=[];this.changed?.({choices:[],effective:null});}
  next(){const fields=this.queued;this.queued=null;if(fields)this.request(fields);}
  async consume(message){
    if(!message||!['audio_capabilities','audio_config_result'].includes(message.t))return false;
    if(message.v!==1)return true;
    if(message.t==='audio_capabilities'){
      if(!generation(message.sourceGeneration)||!Array.isArray(message.codecs)||message.codecs.length>2)return true;
      const epoch=++this.epoch;this.capability=null;this.choices=[];this.clearPending();this.queued=null;
      const aac=message.codecs.find(c=>c?.codec==='mp4a.40.2');
      try{
        if(!aac||!Array.isArray(aac.bitratesBps)||!aac.bitratesBps.length||aac.bitratesBps.length>4||
          !aac.bitratesBps.every(b=>[96000,128000,160000,192000].includes(b)))throw Error('unsupported');
        const config=aacConfig(aac);
        if(!this.Decoder||!(await this.Decoder.isConfigSupported(config)).supported)throw Error('unsupported');
        if(epoch!==this.epoch)return true;
        this.capability={...aac,sourceGeneration:message.sourceGeneration};
        this.choices=[...new Set(aac.bitratesBps)].sort((a,b)=>a-b);
      }catch{if(epoch!==this.epoch)return true;}
      this.changed({choices:this.choices,effective:this.active});return true;
    }
    const pending=this.pending;
    const fallback=message.status==='applied'&&message.codec==='pcm_s16le'&&
      message.requestId===this.active?.requestId&&['encoder_failed_pcm_fallback','source_changed'].includes(message.reason);
    if(!pending&&!fallback||pending&&message.requestId!==pending.requestId&&!fallback)return true;
    if(!['applied','rejected'].includes(message.status)||!generation(message.generation)||!generation(message.sourceGeneration))return true;
    if(message.status==='rejected'){this.clearPending();this.changed({choices:this.choices,effective:this.active});this.next();return true;}
    if(!fallback){
      if(message.codec!==pending.codec)return true;
      if(message.codec==='mp4a.40.2'&&['sourceGeneration','sampleRate','channels','targetBitrate'].some(k=>message[k]!==pending[k]))return true;
    }
    if(pending?.requestId===message.requestId)this.clearPending();
    this.active={...message};this.applied(message);
    this.changed({choices:this.choices,effective:this.active});if(!this.pending)this.next();return true;
  }
  select(bitrate){
    if(!this.capability||!this.choices.includes(bitrate))return false;
    const c=this.capability;
    return this.request({codec:c.codec,sourceGeneration:c.sourceGeneration,sampleRate:c.sampleRate,
      channels:c.channels,description:c.description,targetBitrate:bitrate});
  }
  pcm(){return this.request({codec:'pcm_s16le'});}
  request(fields){
    // Keep one in-flight request and at most the latest user intent. A timeout
    // changes the notice, not correlation: next source chunk can legitimately ack late.
    if(this.pending){this.queued=fields;return true;}
    const request={t:'audio_config',v:1,requestId:this.makeId(),...fields};
    this.clearPending();this.pending=request;
    this.timer=this.schedule(()=>{
      if(this.pending!==request)return;
      this.timer=null;this.changed({choices:this.choices,effective:this.active,error:'confirmation_timeout'});
    },5000);
    try{this.send(request);return true;}catch{
      this.clearPending();this.changed({choices:this.choices,effective:this.active,error:'send_failed'});return false;
    }
  }
}
