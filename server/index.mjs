import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {Store} from './store.mjs';
import {createApp} from './app.mjs';
const env=process.env;
if(env.NODE_ENV==='production'&&(!env.PUBLIC_ORIGIN?.startsWith('https://')||!env.GAME_BRIDGE_SECRET||env.GAME_BRIDGE_SECRET.length<32))throw Error('Production requires an HTTPS PUBLIC_ORIGIN and a strong GAME_BRIDGE_SECRET.');
const path=env.DATABASE_PATH||'data/nugget-website.db';mkdirSync(dirname(path),{recursive:true});const store=new Store(path);
async function razor(path,body){const response=await fetch('https://api.razorpay.com/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(env.RAZORPAY_KEY_ID+':'+env.RAZORPAY_KEY_SECRET).toString('base64'),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});const data=await response.json();if(!response.ok)throw Error('Payment provider unavailable');return data;}
const gateway={findOrder:async receipt=>(await razor('/orders?receipt='+encodeURIComponent(receipt))).items?.find(o=>o.receipt===receipt),createOrder:body=>razor('/orders',body),fetchPayment:id=>razor('/payments/'+encodeURIComponent(id))};
const host=env.BIND_HOST||'127.0.0.1';
const app=createApp(store,env,gateway);const server=app.listen(Number(env.PORT)||8787,host,()=>console.log('Nugget website API listening on '+host+':'+(Number(env.PORT)||8787)));
const clean=setInterval(()=>store.clean(),3600000);clean.unref();
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>{store.close();process.exit(0);}));
