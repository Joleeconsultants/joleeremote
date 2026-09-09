import {it,expect} from 'vitest';
import {parseInputJson} from '../src/input';
it('retains catalog identities through input parsing and rejects partial or ambiguous commands',()=>{
  const base={display_id:'a'.repeat(32),catalog_revision:'b'.repeat(32),request_id:'request'};
  const manual={t:'resize',...base,mode:'manual',mode_id:'c'.repeat(32),w:1366,h:768};
  const fit={t:'resize',...base,mode:'best_fit',w:1365,h:767};
  const select={t:'display_select',...base};
  for(const command of [manual,fit,select]) expect(parseInputJson(JSON.stringify(command))).toEqual(command);
  for(const command of [{...manual,mode_id:undefined},{...manual,catalog_revision:undefined},
    {...manual,id:'legacy'},{...fit,mode_id:'c'.repeat(32)},{...fit,w:1.5},{...select,display_id:'primary'},
    {...select,request_id:''}]) expect(parseInputJson(JSON.stringify(command))).toBeNull();
  expect(parseInputJson('{"t":"resize","mode":"auto","w":1280,"h":720,"reset":true}')).not.toBeNull();
});
