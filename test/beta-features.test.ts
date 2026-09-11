import {describe,it,expect} from 'vitest';
import {betaFeatures,betaMessageAllowed} from '../src/beta-features';
import {encodeEnvelope,decodeEnvelope} from '../src/envelope';
const off=betaFeatures(null), on=betaFeatures({printingBeta:true,microphoneBeta:true});
const allow=(kind:'frame'|'input'|'audio',value:unknown,flags=off)=>betaMessageAllowed(decodeEnvelope(encodeEnvelope(kind,JSON.stringify(value)))!,flags);
describe('device beta relay gates',()=>{
 it('requires exact true and keeps flags independent',()=>{
  expect(betaFeatures({printingBeta:'true',microphoneBeta:1})).toEqual(off);
  expect(allow('frame',{t:'print'},betaFeatures({microphoneBeta:true}))).toBe(false);
  expect(allow('input',{t:'mic'},betaFeatures({printingBeta:true}))).toBe(false);
 });
 it('blocks print and microphone variants by default but allows explicit opt-in',()=>{
  for(const [kind,value] of [['frame',{t:'print'}],['frame',{type:'print'}],['input',{t:'mic'}],['input',{t:'pipeline',pipeline:'microphone',enabled:true}],['input',{t:'audioDevice',context:'input'}],['input',{t:'settings',settings:{microphone_enabled:true}}]] as const){
   expect(allow(kind,value)).toBe(false);expect(allow(kind,value,on)).toBe(true);
  }
 });
 it('preserves PC sound, keyboard, files, and microphone shutdown',()=>{
  expect(allow('audio',{})).toBe(true);
  for(const value of [{t:'key',e:'down'},{t:'file',name:'a.pdf'},{t:'pipeline',pipeline:'audio',enabled:true},{t:'pipeline',pipeline:'microphone',enabled:false},{t:'settings',settings:{encoder:'jpeg'}}])expect(allow('input',value)).toBe(true);
 });
});
