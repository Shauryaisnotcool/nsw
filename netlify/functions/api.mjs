import serverless from 'serverless-http';
import {createApp} from '../../server/app.mjs';
import {openPostgresStore} from '../../server/postgres.mjs';
import {exchangeRate} from '../../server/pg-upi.mjs';

let appPromise;

async function razor(path, env, body) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw Error('Payment provider is not configured.');
  const response = await fetch('https://api.razorpay.com/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Basic ' + Buffer.from(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw Error('Payment provider unavailable.');
  return data;
}

async function getHandler() {
  if (!appPromise) {
    appPromise = (async () => {
      const env = process.env;
      if (!env.DATABASE_URL) throw Error('DATABASE_URL is not configured for this Netlify Function.');
      const store = await openPostgresStore(env.DATABASE_URL, {
        schema: env.SUPABASE_DB_SCHEMA || 'nugget_web',
        max: 2,
        migrate: true
      });
      const gateway = {
        exchangeRate,
        findOrder: receipt => razor('/orders?receipt=' + encodeURIComponent(receipt), env),
        createOrder: body => razor('/orders', env, body),
        fetchPayment: id => razor('/payments/' + encodeURIComponent(id), env)
      };
      return serverless(createApp(store, env, gateway));
    })().catch(error => {
      appPromise = undefined;
      throw error;
    });
  }
  return appPromise;
}

export async function handler(event, context) {
  // Direct function URLs include the internal prefix; a redirect from /api/*
  // should still reach the same Express routes.
  const clean = value => typeof value === 'string' ? value.replace(/^\/.netlify\/functions\/api(?=\/|$)/, '') || '/' : value;
  const path = clean(event?.path);
  const request = path && path !== event.path ? {...event, path, rawPath: clean(event.rawPath), requestPath: clean(event.requestPath)} : event;
  return (await getHandler())(request, context);
}
