// Connection state is independent of the last frame left on the canvas.
export class SessionState {
  constructor(render) { this.render=render; this.paired=false; this.fresh=false; this.terminal=false; this.set('connecting'); }
  set(state) {
    this.terminal=['ended','expired','unavailable'].includes(state);
    if(state!=='paired'){this.paired=false;this.fresh=false;}
    else if(!this.paired){this.paired=true;this.fresh=false;}
    const text={connecting:'Connecting…',waiting:'Waiting for the PC to connect. The last screen is not live.',
      disconnected:'Connection lost. Reconnecting. The last screen is not live.',
      ended:'Session ended. The last screen is not live.',
      expired:'Session expired. The last screen is not live.',
      unavailable:'Session unavailable. Open a new session to connect again.',
      paused:'Video is paused.',paired:'Connected. Waiting for a fresh screen…'};
    this.render({state,text:text[state]||'Session unavailable.',visible:state!=='paired'||!this.fresh,terminal:this.terminal});
  }
  frame(){if(this.paired&&!this.terminal){this.fresh=true;this.set('paired');}}
  stale(text){if(this.paired&&!this.terminal){this.fresh=false;this.render({state:'paired',text,visible:true,terminal:false});}}
}
