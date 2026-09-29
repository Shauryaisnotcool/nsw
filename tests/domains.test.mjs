import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store,hash,VERSION} from '../server/store.mjs';
import {createApp,signature} from '../server/app.mjs';

test('custom and Netlify domains share a secured bridge and reject other browser origins',async t=>{
 const store=new Store(':memory:');
 const env={PUBLIC_ORIGIN:'https://nuggetsmp.online',PUBLIC_ORIGIN_ALIASES:'https://nuggetsmp.netlify.app',GAME_BRIDGE_SECRET:'s'.repeat(64)};
 const server=createApp(store,env).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
 const base='http://127.0.0.1:'+server.address().port;
 for(const origin of [env.PUBLIC_ORIGIN,env.PUBLIC_ORIGIN_ALIASES]){
  const response=await fetch(base+'/api/auth/challenge',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({termsAccepted:true,termsVersion:VERSION,privacyVersion:VERSION})});
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  assert.match(response.headers.get('set-cookie'),/Secure/);
 }
 for(const origin of ['https://nuggetsmp.netlify.app.evil.example','https://other.netlify.app','null']){
  const response=await fetch(base+'/api/auth/challenge',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,403);
 }
 const path='/api/bridge/heartbeat',body=JSON.stringify({online:true,players:3,max:100,version:'1.21.11'}),ts=String(Date.now()),nonce=randomUUID();
 const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Nugget-Timestamp':ts,'X-Nugget-Nonce':nonce,'X-Nugget-Signature':signature(env.GAME_BRIDGE_SECRET,ts+'\n'+nonce+'\nPOST\n'+path+'\n'+hash(body))},body});
 assert.equal(response.status,200);
 const status=await fetch(base+'/api/status');assert.equal(status.headers.get('cache-control'),'no-store');
 const data=await status.json();assert.equal(data.address,'play.nuggetsmp.online:25590');assert.equal(data.online,3);
});

test('production aliases must be exact HTTPS origins',()=>{
 const store=new Store(':memory:');
 try{for(const alias of ['*','http://nuggetsmp.netlify.app','https://nuggetsmp.netlify.app/path'])
  assert.throws(()=>createApp(store,{PUBLIC_ORIGIN:'https://nuggetsmp.online',PUBLIC_ORIGIN_ALIASES:alias}));
 }finally{store.close();}
});
