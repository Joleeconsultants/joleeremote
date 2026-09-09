// PC save receipts for the existing single-envelope Files lane.
const LIMIT = 1024 * 1024;
const rejected = new Set(['invalid_request','too_large','exists','unavailable','cancelled','write_failed','limit_reached']);
const uncertain = new Set(['cleanup_failed','completion_unknown']);
const messages = {
  invalid_request:'The PC rejected this file.', too_large:'This file exceeds the upload limit.',
  exists:'A file with this name already exists on the PC.', unavailable:'The PC upload folder is unavailable.',
  cancelled:'The upload was cancelled.', write_failed:'The PC could not save this file.',
  limit_reached:'This session has reached its upload limit. Open a new session.',
};
export class UploadControl {
  constructor({send,report,encode,id=()=>crypto.randomUUID(),now=()=>Date.now(),timer=(fn,ms)=>setTimeout(fn,ms),clear=handle=>clearTimeout(handle)}) {
    Object.assign(this,{send,report,encode,id,now,timer,clear});
    this.connection=null; this.generation=0; this.pending=null; this.supported=false; this.supportAt=0; this.deadline=null;
  }
  bind(connection,deadline=null) {
    if(connection!==this.connection){this.finish('warning','Upload completion could not be confirmed. Check the PC before retrying.');this.generation++;this.supported=false;this.supportAt=0;}
    this.connection=connection;
    if(Number.isSafeInteger(deadline))this.deadline=deadline;
    else if(!connection)this.deadline=null;
  }
  capability(value){this.supported=value===true;this.supportAt=this.now();}
  finish(status,message) {
    const p=this.pending;if(!p)return;
    this.pending=null;this.clear(p.timer);
    this.report({requestId:p.id,fileName:p.name,fileSize:p.bytes,status,message});
  }
  async upload(file) {
    if(this.pending){this.report({requestId:this.id(),fileName:'Upload',status:'warning',message:'Wait for the current upload to finish.'});return;}
    if(!file||typeof file.arrayBuffer!=='function')return;
    const p={id:this.id(),name:typeof file.name==='string'?file.name:'upload',bytes:file.size,connection:this.connection,generation:this.generation};
    this.pending=p;this.report({requestId:p.id,fileName:p.name,fileSize:p.bytes,status:'start'});
    if(!this.connection||this.connection.readyState!==1||this.deadline!==null&&this.now()>=this.deadline){this.finish('error','The session is disconnected.');return;}
    if(!Number.isSafeInteger(p.bytes)||p.bytes<0||p.name.length<1||p.name.length>255||/[\\/]/.test(p.name)){this.finish('error',messages.invalid_request);return;}
    // Reject huge selections before reading/allocating their base64 representation.
    if(4*Math.ceil(p.bytes/3)+2>LIMIT){this.finish('error',messages.too_large);return;}
    const acknowledged=this.supported&&this.now()-this.supportAt>=0&&this.now()-this.supportAt<5000;
    p.acknowledged=acknowledged;
    const duration=Math.min(30000,this.deadline===null?30000:Math.max(0,this.deadline-this.now()));
    p.timer=this.timer(()=>this.finish('warning','Upload completion could not be confirmed. Check the PC before retrying.'),duration);
    try {
      const data=new Uint8Array(await file.arrayBuffer());
      if(this.pending!==p)return;
      if(data.length!==p.bytes)throw new Error('read');
      let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
      const payload={t:'file',name:p.name,mime:file.type||'application/octet-stream',data:btoa(binary)};
      if(acknowledged)payload.id=p.id;
      const frame=this.encode(payload);
      if(frame.length>LIMIT){this.finish('error',messages.too_large);return;}
      if(this.connection!==p.connection||this.generation!==p.generation||p.connection.readyState!==1||this.deadline!==null&&this.now()>=this.deadline){this.finish('warning','Upload completion could not be confirmed. Check the PC before retrying.');return;}
      p.sent=true;
      this.send(frame,p.connection);
      if(!acknowledged&&this.pending===p)this.finish('warning','File sent; this PC cannot confirm that it was saved. Check the PC before retrying.');
    } catch {
      if(this.pending===p)this.finish(p.sent?'warning':'error',p.sent?'Upload completion could not be confirmed. Check the PC before retrying.':'The selected file could not be read.');
    }
  }
  consume(value,connection) {
    if(value?.t!=='file_upload_result')return false;
    const p=this.pending;
    if(!p||!p.sent||!p.acknowledged||connection!==p.connection||connection!==this.connection||p.generation!==this.generation||value.id!==p.id)return true;
    if(this.deadline!==null&&this.now()>=this.deadline){this.finish('warning','Upload completion could not be confirmed. Check the PC before retrying.');return true;}
    const valid=value&&Object.keys(value).length===6&&['t','id','status','name','bytes','reason'].every(k=>Object.hasOwn(value,k));
    if(!valid)return true;
    if(value.status==='saved'&&value.reason===null&&value.name===p.name&&Number.isSafeInteger(value.bytes)&&value.bytes===p.bytes)this.finish('end');
    else if(value.status==='rejected'&&value.name===null&&value.bytes===null&&rejected.has(value.reason))this.finish('error',messages[value.reason]);
    else if(value.status==='uncertain'&&value.name===null&&value.bytes===null&&uncertain.has(value.reason))this.finish('warning','Upload completion could not be confirmed. Check the PC before retrying.');
    return true;
  }
}
