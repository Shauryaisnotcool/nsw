import express from 'express';
import { PlayerStats } from './stats.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { UpiCheckout, exchangeRate } from './upi.mjs';
import { hash, VERSION } from './pg-store.mjs';
export function signature(secret, text) {
  return createHmac('sha256', secret).update(text).digest('hex');
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createApp(store, env = {}, gateway) {
  const stats = store.stats || new PlayerStats(store);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const origin = env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173',
    secure = new URL(origin).protocol === 'https:';
  const allowedOrigins = new Set([origin, ...(env.PUBLIC_ORIGIN_ALIASES || '').split(',').map(v => v.trim()).filter(Boolean)].map(value => {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol) || secure && url.protocol !== 'https:') throw Error('Use exact HTTPS origins in PUBLIC_ORIGIN_ALIASES.');
    return value;
  }));
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/'
  };
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a.length === 2));
  const ready = () => !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET && env.OPERATOR_NAME && env.SUPPORT_EMAIL);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    next();
  });
  const bridge = async (req, res, next) => {
    const ts = req.get('X-Nugget-Timestamp'),
      nonce = req.get('X-Nugget-Nonce'),
      sig = req.get('X-Nugget-Signature');
    if (!env.GAME_BRIDGE_SECRET || env.GAME_BRIDGE_SECRET.length < 32) return res.status(503).json({
      error: 'Game bridge is not configured.'
    });
    if (!Buffer.isBuffer(req.body) || !/^\d{13}$/.test(ts || '') || Math.abs(store.now() - Number(ts)) > 60000 || !/^[a-f0-9-]{36}$/.test(nonce || '')) return res.status(401).json({
      error: 'Invalid bridge request.'
    });
    const expected = signature(env.GAME_BRIDGE_SECRET, ts + '\n' + nonce + '\n' + req.method + '\n' + req.originalUrl + '\n' + hash(req.body));
    if (!equal(sig, expected) || !(await store.nonce(nonce))) return res.status(401).json({
      error: 'Invalid bridge signature or replay.'
    });
    try {
      req.body = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({
        error: 'Invalid JSON.'
      });
    }
    next();
  };
  app.use('/api/bridge', express.raw({
    type: 'application/json',
    limit: '1mb'
  }), bridge);
  app.post('/api/bridge/season', async (req, res) => res.json({
    ok: await stats.setSeason(req.body)
  }));
  app.post('/api/bridge/telemetry', async (req, res) => {
    await stats.ingest(req.body);
    res.json({
      ok: true
    });
  });
  app.post('/api/bridge/verify', async (req, res) => {
    const {
      code,
      uuid,
      name
    } = req.body;
    if (!/^[a-z2-9]{4}-[a-z2-9]{4}$/.test(code || '') || !uuidValid(uuid) || !/^[.a-zA-Z0-9_ ]{1,32}$/.test(name || '')) return res.status(400).json({
      error: 'Invalid verification data.'
    });
    if (!(await store.rate('verify:' + uuid, 10, 600000))) return res.status(429).json({
      error: 'Too many attempts. Try again later.'
    });
    res.json({
      verified: await store.verify(code, uuid, name)
    });
  });
  app.post('/api/bridge/heartbeat', async (req, res) => {
    const p = req.body;
    if (typeof p.online !== 'boolean' || !Number.isInteger(p.players) || p.players < 0 || !Number.isInteger(p.max) || p.max < 1 || p.players > p.max || typeof p.version !== 'string' || p.version.length > 60) return res.status(400).json({
      error: 'Invalid server snapshot.'
    });
    await store.heartbeat(p);
    res.json({
      ok: true
    });
  });
  app.post('/api/bridge/deliveries', async (req, res) => res.json({
    orders: await store.deliveries()
  }));
  app.post('/api/bridge/ack', async (req, res) => {
    const {
      id,
      uuid,
      until
    } = req.body;
    if (!/^[a-f0-9]{32}$/.test(id || '') || !uuidValid(uuid) || !Number.isSafeInteger(until) || until < 0) return res.status(400).json({
      error: 'Invalid delivery.'
    });
    await store.acknowledge(id, uuid, until);
    res.json({
      ok: true
    });
  });
  app.post('/api/webhooks/razorpay', express.raw({
    type: 'application/json',
    limit: '256kb'
  }), async (req, res) => {
    if (!env.RAZORPAY_WEBHOOK_SECRET || !equal(req.get('X-Razorpay-Signature'), signature(env.RAZORPAY_WEBHOOK_SECRET, req.body))) return res.status(401).json({
      error: 'Invalid signature.'
    });
    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({
        error: 'Invalid JSON.'
      });
    }
    if (event.event === 'payment.captured') await store.captured(event.payload?.payment?.entity || {});
    res.json({
      ok: true
    });
  });
  app.use(express.json({
    limit: '16kb'
  }));
  app.use('/api', async (req, res, next) => {
    if (req.method === 'POST' && !allowedOrigins.has(req.get('origin'))) return res.status(403).json({
      error: 'Request origin is not allowed.'
    });
    if (!(await store.rate('http:' + hash(req.ip || 'unknown-client'), 240, 60000))) return res.status(429).json({
      error: 'Too many requests. Please wait a minute.'
    });
    next();
  });
  app.get('/api/season', async (req, res) => res.json(await stats.season()));
  app.get('/api/status', async (req, res) => {
    const season = await stats.season(),
      status = await store.status(env.MC_ADDRESS || 'play.nuggetsmp.online:25590', Number(env.BEDROCK_PORT) || null);
    res.json({
      ...status,
      season,
      ...(season.phase === 'resetting' ? {
        state: 'resetting',
        online: 0
      } : {})
    });
  });
  app.get('/api/config', (req, res) => {
    let staff = [{
      name: 'that1shaurya',
      role: 'Owner'
    }];
    try {
      if (env.STAFF_JSON) staff = JSON.parse(env.STAFF_JSON);
    } catch {}
    res.json({
      staff,
      supportEmail: env.SUPPORT_EMAIL || null,
      operatorName: env.OPERATOR_NAME || null,
      checkoutReady: ready(),
      upiReady: upiReady()
    });
  });
  app.post('/api/auth/challenge', async (req, res) => {
    if (req.body.termsAccepted !== true || req.body.termsVersion !== VERSION || req.body.privacyVersion !== VERSION) return res.status(400).json({
      error: 'Please accept the current terms and privacy policy.'
    });
    if (!(await store.rate('challenge:' + hash(req.ip), 5, 600000))) return res.status(429).json({
      error: 'Please wait before requesting another code.'
    });
    const result = await store.challenge();
    res.cookie('ng_challenge', result.browser, {
      ...cookieOpts,
      maxAge: 600000
    });
    res.json({
      code: result.code,
      expires: result.expires
    });
  });
  app.get('/api/auth/poll', async (req, res) => {
    const result = await store.poll(cookies(req).ng_challenge);
    if (result.session) {
      res.cookie('ng_session', result.session, {
        ...cookieOpts,
        maxAge: 30 * 86400000
      });
      res.clearCookie('ng_challenge', cookieOpts);
      delete result.session;
    } else {
      const u = await store.session(cookies(req).ng_session);
      if (u) return res.json({
        user: u
      });
    }
    res.json(result);
  });
  app.get('/api/auth/me', async (req, res) => res.json({
    user: await store.session(cookies(req).ng_session)
  }));
  app.post('/api/auth/logout', async (req, res) => {
    await store.logout(cookies(req).ng_session);
    res.clearCookie('ng_session', cookieOpts);
    res.json({
      ok: true
    });
  });
  const auth = async (req, res, next) => {
    req.user = await store.session(cookies(req).ng_session);
    if (!req.user) return res.status(401).json({
      error: 'Link your Minecraft account first.'
    });
    next();
  };
  const upi = store.upi || new UpiCheckout(store);
  const upiReady = () => env.UPI_MANUAL_REVIEW_ENABLED === 'true' && !!env.OPERATOR_NAME && !!env.SUPPORT_EMAIL;
  app.post('/api/checkout/upi', auth, async (req, res) => {
    if (!upiReady()) return res.status(503).json({
      error: 'UPI checkout opens when bank-payment review and support are configured.'
    });
    if (req.body.immediateDelivery !== true) return res.status(400).json({
      error: 'Please confirm the purchase terms.'
    });
    if (!(await store.rate('upi:' + req.user.uuid, 6, 600000))) return res.status(429).json({
      error: 'Please wait before generating another QR.'
    });
    const quote = await (gateway?.exchangeRate || exchangeRate)();
    const order = await store.order(req.user.uuid, req.body.days, req.body.discountCode || '');
    res.json(await upi.image(await upi.create(order, quote)));
  });
  app.get('/api/checkout/upi/:id', auth, async (req, res) => {
    const a = await upi.get(req.params.id, req.user.uuid);
    if (!a) return res.status(404).json({
      error: 'Checkout not found.'
    });
    res.json(await upi.image(a));
  });
  app.post('/api/checkout/upi/:id/cancel', auth, async (req, res) => {
    const a = await upi.cancel(req.params.id, req.user.uuid);
    if (!a) return res.status(404).json({
      error: 'Checkout not found.'
    });
    res.json(a);
  });
  app.get('/api/staff', async (req, res) => res.json(await stats.roster()));
  app.get('/api/stats', async (req, res) => {
    const page = Math.min(10000, Math.max(0, Number.parseInt(req.query.page) || 0));
    res.json({
      players: await stats.search(typeof req.query.q === 'string' ? req.query.q : '', page),
      updated: store.now()
    });
  });
  app.get('/api/stats/:uuid', async (req, res) => {
    const p = await stats.get(req.params.uuid);
    if (!p) return res.status(404).json({
      error: 'Player not found. Profiles appear after the server syncs.'
    });
    res.json(p);
  });
  const staff = async (req, res, next) => {
    req.staff = await stats.staff(req.user.uuid);
    if (!req.staff) return res.status(403).json({
      error: 'Sign in as online server staff. Access expires when permissions or the server connection cannot be checked.'
    });
    next();
  };
  app.get('/api/moderation/me', auth, staff, (req, res) => res.json({
    name: req.user.name,
    role: req.staff
  }));
  app.get('/api/moderation/:uuid/:kind', auth, staff, async (req, res) => {
    if (!['inventory', 'punishments'].includes(req.params.kind)) return res.status(404).json({
      error: 'Unknown inspection'
    });
    const result = await stats.inspect(req.user.uuid, req.params.uuid, req.params.kind);
    if (!result) return res.status(404).json({
      error: 'Player not found'
    });
    res.json(result);
  });
  const pending = new Map();
  app.post('/api/checkout', auth, async (req, res) => {
    if (!ready()) return res.status(503).json({
      error: 'Purchases are not open yet. Your account is linked and your welcome discount will be waiting.'
    });
    if (req.body.immediateDelivery !== true) return res.status(400).json({
      error: 'Please confirm immediate delivery of your rank.'
    });
    if (!(await store.rate('checkout:' + req.user.uuid, 10, 600000))) return res.status(429).json({
      error: 'Please wait before retrying checkout.'
    });
    const order = await store.order(req.user.uuid, req.body.days, req.body.discountCode || '');
    if (order.provider_id?.startsWith('upi_')) return res.status(409).json({
      error: "This purchase has a UPI request. Contact support before switching payment methods."
    });
    let providerId = order.provider_id;
    if (!providerId) {
      let job = pending.get(order.id);
      if (!job) {
        job = (async () => {
          const found = await gateway.findOrder(order.id);
          const remote = found || (await gateway.createOrder({
            amount: order.amount,
            currency: 'USD',
            receipt: order.id,
            notes: {
              minecraft_uuid: order.uuid,
              local_order_id: order.id
            }
          }));
          if (remote.amount !== order.amount || remote.currency !== 'USD') throw Error('Payment provider returned an incorrect order.');
          await store.attach(order.id, remote.id);
          return remote.id;
        })();
        pending.set(order.id, job);
        job.finally(() => pending.delete(order.id)).catch(() => {});
      }
      providerId = await job;
    }
    res.json({
      provider: 'razorpay',
      key: env.RAZORPAY_KEY_ID,
      order_id: providerId,
      amount: order.amount,
      currency: 'USD',
      name: 'Nugget SMP',
      description: `Nugget+ · ${order.days} days`
    });
  });
  app.post('/api/checkout/confirm', auth, async (req, res) => {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;
    const o = await store.db.prepare('SELECT * FROM orders WHERE provider_id=? AND uuid=?').get(razorpay_order_id || '', req.user.uuid);
    if (!o || !equal(razorpay_signature, signature(env.RAZORPAY_KEY_SECRET || '', o.provider_id + '|' + razorpay_payment_id))) return res.status(400).json({
      error: 'Payment verification failed.'
    });
    const payment = await gateway.fetchPayment(razorpay_payment_id);
    if (payment.order_id !== o.provider_id) return res.status(400).json({
      error: 'Payment order mismatch.'
    });
    if (payment.status !== 'captured') return res.json({
      pending: true
    });
    await store.captured(payment);
    res.json({
      paid: true
    });
  });
  app.use('/api', (req, res) => res.status(404).json({
    error: 'Endpoint not found.'
  }));
  app.use(express.static(resolve('out'), {
    maxAge: '1h'
  }));
  app.get('/{*path}', (req, res) => res.status(404).sendFile(resolve('out/404.html')));
  app.use((err, req, res, next) => {
    console.error('[website]', err.message);
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({
      error: err.message.includes('discount') || err.message.includes('plan') || err.message.includes('duration') ? err.message : 'The request could not be completed. Please retry or contact support.'
    });
  });
  return app;
}
function uuidValid(s) {
  return typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
}
