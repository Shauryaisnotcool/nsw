import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,hash,VERSION} from '../server/store.mjs';
import {createApp,signature} from '../server/app.mjs';

const player='3bf9d832-6bb3-480b-8140-141989cbfd5e';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'nugget-web-test-'));let time=Date.now();const file=join(dir,'test.db');const store=new Store(file,()=>time);t.after(()=>{try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});});return {store,file,advance:n=>time+=n};}
function login(store,id=player){const c=store.challenge();assert.equal(store.verify(c.code,id,'TestMiner'),true);return store.poll(c.browser);}
test('verification codes are unique, account-bound, single-use, and expire',t=>{const {store,advance}=fixture(t);const codes=new Set();for(let i=0;i<100;i++){const c=store.challenge();assert.match(c.code,/^[a-z2-9]{4}-[a-z2-9]{4}$/);assert.ok(!codes.has(c.code));codes.add(c.code);}const c=store.challenge();assert.deepEqual(store.poll(c.browser),{pending:true});assert.equal(store.verify(c.code,player,'TestMiner'),true);assert.equal(store.verify(c.code,randomUUID(),'Imposter'),false);assert.equal(store.poll('wrong-browser').expired,true);const result=store.poll(c.browser);assert.equal(result.user.uuid,player);assert.equal(store.session(result.session).uuid,player);assert.equal(store.verify(c.code,player,'TestMiner'),false);const expired=store.challenge();advance(600001);assert.equal(store.verify(expired.code,player,'TestMiner'),false);assert.equal(store.poll(expired.browser).expired,true);});
test('restart preserves account, session, one welcome discount and order',t=>{const {store,file}=fixture(t);const user=login(store);const again=login(store);assert.equal(again.user.discountCode,user.user.discountCode);const o=store.order(player,30,user.user.discountCode);assert.equal(o.amount,269);store.attach(o.id,'order_restart');store.close();const restored=new Store(file);t.after(()=>restored.close());assert.equal(restored.session(user.session).uuid,player);assert.equal(restored.order(player,30,user.user.discountCode).id,o.id);assert.throws(()=>restored.order(player,90,user.user.discountCode),/reserved/);});
test('payment duplicates cannot deliver twice, forge prices or reuse the discount',t=>{const {store}=fixture(t);const {user}=login(store);const o=store.order(player,7,user.discountCode);assert.equal(o.amount,89);store.attach(o.id,'order_1');assert.throws(()=>store.captured({id:'pay_a',order_id:'order_1',status:'captured',amount:1,currency:'USD'}));const payment={id:'pay_a',order_id:'order_1',status:'captured',amount:89,currency:'USD'};store.captured(payment);store.captured(payment);assert.equal(store.deliveries().length,1);const until=Date.now()+7*86400000;store.acknowledge(o.id,player,until);store.acknowledge(o.id,player,until+86400000);assert.equal(store.deliveries().length,0);assert.equal(store.user(player).plusUntil,until);assert.equal(store.user(player).discountCode,null);assert.throws(()=>store.order(player,7,user.discountCode),/already been used/);assert.throws(()=>store.order(player,365,''),/valid/);});
test('unauthorized discount and delivery acknowledgement are rejected',t=>{const {store}=fixture(t);const a=login(store),b=login(store,randomUUID());assert.throws(()=>store.order(b.user.uuid,7,a.user.discountCode),/belong/);const o=store.order(player,90,'');assert.throws(()=>store.acknowledge(o.id,player,Date.now()),/not found/);});
test('server status does not report stale counts as online',t=>{const {store,advance}=fixture(t);assert.equal(store.status('',19132).online,null);store.heartbeat({online:true,players:7,max:100,version:'1.21.11'});assert.equal(store.status('play.example.test',19132).online,7);advance(90001);const s=store.status('play.example.test',19132);assert.equal(s.state,'stale');assert.equal(s.online,null);store.heartbeat({online:false,players:0,max:100,version:'1.21.11'});assert.equal(store.status('',19132).state,'offline');});
test('HTTP login, signed bridge, checkout and webhook delivery work end to end',async t=>{
 const {store}=fixture(t);const secret='b'.repeat(64);const env={PUBLIC_ORIGIN:'https://nugget.example',GAME_BRIDGE_SECRET:secret,RAZORPAY_KEY_ID:'rzp_test_fake',RAZORPAY_KEY_SECRET:'test-key',RAZORPAY_WEBHOOK_SECRET:'test-webhook',OPERATOR_NAME:'Test Operator',SUPPORT_EMAIL:'support@example.test'};
 let created=0;let payment;const gateway={findOrder:async()=>null,createOrder:async o=>{created++;return {...o,id:'order_integration'};},fetchPayment:async()=>payment};
 const app=createApp(store,env,gateway),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body,cookie='',extra={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:env.PUBLIC_ORIGIN,Cookie:cookie,...extra},body:JSON.stringify(body)});
 let response=await post('/api/auth/challenge',{termsAccepted:false});assert.equal(response.status,400);
 response=await post('/api/auth/challenge',{termsAccepted:true,termsVersion:VERSION,privacyVersion:VERSION});const c=await response.json();const browser=response.headers.getSetCookie()[0].split(';')[0];assert.ok(response.headers.getSetCookie()[0].includes('HttpOnly'));
 const body={code:c.code,uuid:player,name:'TestMiner'},raw=JSON.stringify(body),timestamp=String(store.now()),nonce=randomUUID(),sig=signature(secret,timestamp+'\n'+nonce+'\nPOST\n/api/bridge/verify\n'+hash(raw));
 response=await post('/api/bridge/verify',body,'',{'X-Nugget-Timestamp':timestamp,'X-Nugget-Nonce':nonce,'X-Nugget-Signature':'bad'});assert.equal(response.status,401);
 const headers={'X-Nugget-Timestamp':timestamp,'X-Nugget-Nonce':nonce,'X-Nugget-Signature':sig};response=await post('/api/bridge/verify',body,'',headers);assert.equal((await response.json()).verified,true);assert.equal((await post('/api/bridge/verify',body,'',headers)).status,401);
 response=await fetch(base+'/api/auth/poll',{headers:{Cookie:browser}});const linked=await response.json();const session=response.headers.getSetCookie().find(s=>s.startsWith('ng_session=')).split(';')[0];assert.equal(linked.user.uuid,player);assert.equal(linked.session,undefined);
 response=await post('/api/checkout',{days:30,discountCode:linked.user.discountCode,immediateDelivery:true},session);assert.equal(response.status,200);assert.equal((await response.json()).amount,269);
 await post('/api/checkout',{days:30,discountCode:linked.user.discountCode,immediateDelivery:true},session);assert.equal(created,1);
 payment={id:'pay_integration',order_id:'order_integration',status:'captured',currency:'USD',amount:269};const webhook=JSON.stringify({event:'payment.captured',payload:{payment:{entity:payment}}});
 response=await fetch(base+'/api/webhooks/razorpay',{method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':signature(env.RAZORPAY_WEBHOOK_SECRET,webhook)},body:webhook});assert.equal(response.status,200);assert.equal(store.deliveries().length,1);
 response=await post('/api/checkout/confirm',{razorpay_order_id:'order_integration',razorpay_payment_id:payment.id,razorpay_signature:signature(env.RAZORPAY_KEY_SECRET,'order_integration|'+payment.id)},session);assert.equal((await response.json()).paid,true);assert.equal(store.deliveries().length,1);
 assert.equal((await post('/api/auth/logout',{},session,{Origin:'https://attacker.example'})).status,403);
 await post('/api/auth/logout',{},session);assert.equal((await (await fetch(base+'/api/auth/me',{headers:{Cookie:session}})).json()).user,null);
});

test('UPI requests are unique, expire in 180 seconds, and require bank reconciliation',async t=>{
 const {UpiCheckout}=await import('../server/upi.mjs');const {store,advance}=fixture(t);const {user}=login(store),upi=new UpiCheckout(store);
 const order=store.order(player,7,user.discountCode),quote={rate:90,date:new Date(store.now()).toISOString().slice(0,10)};
 const first=upi.create(order,quote);assert.equal(first.amount,8010);assert.equal(first.expires-first.serverTime,180000);assert.ok(first.uri.includes('9766391181%40fam'));
 const second=upi.create(order,quote);assert.notEqual(first.uri,second.uri);assert.equal(upi.get(first.id,player).state,'cancelled');assert.equal(upi.get(second.id,randomUUID()),null);
 assert.equal(store.deliveries().length,0);assert.ok((await upi.image(second)).qr.startsWith('data:image/png;base64,'));
 assert.throws(()=>upi.reconcile({id:second.id,reference:'123456789012',amount:1,received:store.now()}),/match/);
 const received=store.now();advance(180000);assert.equal(upi.get(second.id,player).state,'expired');assert.equal(upi.get(second.id,player).uri,undefined);
 // A credit received before expiry may be reconciled later without losing the paid entitlement.
 upi.reconcile({id:second.id,reference:'123456789012',amount:8010,received});upi.reconcile({id:second.id,reference:'123456789012',amount:8010,received});assert.equal(store.deliveries().length,1);assert.equal(store.user(player).discountCode,null);
 assert.throws(()=>upi.reconcile({id:first.id,reference:'123456789013',amount:8010,received}),/already paid/);
 const next=upi.create(store.order(player,30,''),quote);advance(180001);assert.throws(()=>upi.reconcile({id:next.id,reference:'late123456',amount:next.amount,received:store.now()}),/Expired/);
 upi.reconcile({id:next.id,reference:'late123456',amount:next.amount,received:store.now(),acceptLate:true});assert.equal(store.deliveries().length,2);
});
test('UPI HTTP checkout is authenticated and never accepts browser payment claims',async t=>{
 const {store}=fixture(t);const {session}=login(store);const env={PUBLIC_ORIGIN:'https://nugget.example',UPI_MANUAL_REVIEW_ENABLED:'true',OPERATOR_NAME:'Test',SUPPORT_EMAIL:'test@example.test'};
 const app=createApp(store,env,{exchangeRate:async()=>({rate:90,date:new Date(store.now()).toISOString().slice(0,10)})}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body,cookie='')=>fetch(base+path,{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 assert.equal((await post('/api/checkout/upi',{days:7,immediateDelivery:true})).status,401);
 const response=await post('/api/checkout/upi',{days:7,immediateDelivery:true},'ng_session='+session);assert.equal(response.status,200);const a=await response.json();assert.equal(a.amount,8910);
 assert.equal((await post('/api/checkout/upi/'+a.id+'/confirm',{paid:true,utr:'123456789012'},'ng_session='+session)).status,404);assert.equal(store.deliveries().length,0);
 assert.equal((await post('/api/checkout/upi/'+a.id+'/cancel',{},'ng_session='+session)).status,200);
 const result=await fetch(base+'/api/checkout/upi/'+a.id,{headers:{Cookie:'ng_session='+session}});assert.equal((await result.json()).state,'cancelled');
});

test('public stats hide moderation data and staff access expires or revokes immediately',async t=>{
 const {PlayerStats,KITS}=await import('../server/stats.mjs');const {store,advance}=fixture(t),stats=new PlayerStats(store);login(store);const target=randomUUID();
 const ratings=Object.fromEntries(['overall',...KITS].map(k=>[k,{elo:1200,wins:3,losses:1}]));const p={uuid:target,name:'GoldMiner',lastSeen:store.now(),playtime:100000,money:50000,nuggets:7,spent7d:10000,earned7d:20000,ratings,punishments:[{id:'private-history',reason:'test'}]};
 stats.ingest({profiles:[p],online:[{uuid:player,role:'mod',captured:store.now(),inventory:[]},{uuid:target,role:'member',captured:store.now(),inventory:[{slot:0,item:'DIAMOND',amount:4}]}]});
 const publicProfile=stats.search('gold')[0];assert.equal(publicProfile.name,'GoldMiner');assert.equal(publicProfile.online,true);assert.equal(publicProfile.ratings.overall.tier,'Gold');assert.equal(JSON.stringify(publicProfile).includes('private-history'),false);assert.equal(publicProfile.inventory,undefined);assert.equal(stats.search('%').length,0);
 assert.equal(stats.staff(player),'mod');assert.equal(stats.inspect(player,target,'inventory').items[0].amount,4);assert.equal(stats.inspect(player,target,'punishments').punishments[0].reason,'test');
 advance(15001);assert.equal(stats.staff(player),null);assert.equal(stats.inspect(player,target,'inventory'),null);
 stats.ingest({profiles:[],online:[{uuid:player,role:'member',captured:store.now(),inventory:[]}]});assert.equal(stats.staff(player),null);assert.equal(stats.get(target).online,false);
});
test('private inspection endpoints reject unsigned telemetry and ordinary logged-in accounts',async t=>{
 const {store}=fixture(t);const {session}=login(store);const server=createApp(store,{PUBLIC_ORIGIN:'https://nugget.example',GAME_BRIDGE_SECRET:'x'.repeat(64)}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/moderation/me')).status,401);
 assert.equal((await fetch(base+'/api/moderation/'+player+'/inventory',{headers:{Cookie:'ng_session='+session}})).status,403);
 assert.equal((await fetch(base+'/api/bridge/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profiles:[],online:[{uuid:player,role:'owner',captured:store.now(),inventory:[]}]})})).status,401);
});

test('staff roster includes offline staff, removes revoked roles and hides stale data',async t=>{
 const {PlayerStats}=await import('../server/stats.mjs');const {store,advance}=fixture(t),stats=new PlayerStats(store),admin=randomUUID();
 const body={profiles:[],online:[],staff:[{uuid:player,name:'OfflineMod',role:'mod'},{uuid:admin,name:'GoldAdmin',role:'admin'}]};
 stats.ingest(body);assert.deepEqual(stats.roster().members.map(p=>p.role),['admin','mod']);assert.equal(stats.staff(player),null);
 stats.ingest({...body,staff:[body.staff[1]]});assert.equal(stats.roster().members.some(p=>p.uuid===player),false);
 assert.throws(()=>stats.ingest({...body,staff:[{...body.staff[0],role:'owner<script>'}]}));assert.equal(stats.roster().members.length,1);
 advance(30001);assert.equal(stats.roster().stale,true);assert.equal(stats.roster().members.length,0);
 stats.ingest({...body,staff:[]});assert.equal(stats.roster().stale,false);assert.equal(stats.roster().members.length,0);
});

test('offline directory and balances survive presence expiry and database restart',async t=>{
 const {PlayerStats,KITS}=await import('../server/stats.mjs');
 const {store,file,advance}=fixture(t),stats=new PlayerStats(store),id=randomUUID();
 const ratings=Object.fromEntries(['overall',...KITS].map(k=>[k,{elo:1270,wins:9,losses:2}]));
 stats.ingest({profiles:[{uuid:id,name:'SavedMiner',lastSeen:store.now(),playtime:900000,money:76543,nuggets:321,spent7d:120,earned7d:800,ratings,punishments:[]}],online:[{uuid:id,role:'member',captured:store.now(),inventory:[]}]});
 advance(60001);
 const offline=stats.search('')[0];assert.equal(offline.uuid,id);assert.equal(offline.online,false);assert.equal(offline.money,76543);assert.equal(offline.nuggets,321);
 store.close();const reopened=new Store(file);t.after(()=>reopened.close());const saved=new PlayerStats(reopened);
 assert.equal(saved.search('saved')[0].uuid,id);assert.equal(saved.search('')[0].ratings.overall.elo,1270);
});

test('season changes erase cached gameplay stats but preserve accounts and purchases',async t=>{
 const {PlayerStats,KITS}=await import('../server/stats.mjs');const {store,advance}=fixture(t),stats=new PlayerStats(store);const linked=login(store),order=store.order(player,30,'');
 const ratings=Object.fromEntries(['overall',...KITS].map(k=>[k,{elo:1300,wins:7,losses:2}]));const body={season:1,profiles:[{uuid:player,name:'SeasonMiner',lastSeen:store.now(),playtime:900000,money:400000,nuggets:777,rewardWins:7,spent7d:1,earned7d:2,ratings}],online:[]};stats.ingest(body);
 stats.setSeason({current:1,next:4,phase:'resetting',changedAt:store.now()});assert.equal(stats.season().phase,'resetting');assert.equal(stats.get(player).nuggets,777);
 advance(300000);stats.setSeason({current:4,next:4,phase:'ready',changedAt:store.now()});assert.equal(stats.search('').length,0);assert.equal(store.session(linked.session).uuid,player);assert.equal(store.order(player,30,'').id,order.id);
 assert.throws(()=>stats.ingest(body),/Stale/);assert.equal(stats.setSeason({current:1,next:1,phase:'ready',changedAt:store.now()+1}),false);
 stats.ingest({...body,season:4,profiles:[{...body.profiles[0],money:100000,playtime:0,rewardWins:0}]});assert.equal(stats.get(player).nuggets,777);assert.equal(stats.get(player).rewardWins,0);
});

test('season endpoints reject unsigned resets and report a maintenance status',async t=>{
 const {PlayerStats}=await import('../server/stats.mjs');const {store}=fixture(t);const stats=new PlayerStats(store);stats.setSeason({current:2,next:3,phase:'resetting',changedAt:store.now()});
 const server=createApp(store,{PUBLIC_ORIGIN:'https://nugget.example',GAME_BRIDGE_SECRET:'x'.repeat(64)}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/bridge/season',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:3,next:3,phase:'ready',changedAt:store.now()})})).status,401);
 const status=await (await fetch(base+'/api/status')).json();assert.equal(status.state,'resetting');assert.equal(status.season.next,3);
});
