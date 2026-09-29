import { randomBytes, randomInt, createHash } from 'node:crypto';
export const hash = s => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export const PRICES = {
  7: 99,
  30: 299,
  90: 499
};
export const VERSION = '2026-09-25';
export function code() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const s = Array.from({
    length: 8
  }, () => abc[randomInt(abc.length)]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}
export class PostgresStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  async transaction(fn) {
    return await this.db.transaction(fn);
  }
  async rate(key, max, window) {
    const now=this.now();
    const row=await this.db.prepare(`INSERT INTO rate_limits AS limits VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN limits.expires<=? THEN 1 ELSE limits.count+1 END,
      expires=CASE WHEN limits.expires<=? THEN ? ELSE limits.expires END
      WHERE limits.expires<=? OR limits.count<? RETURNING count`).get(key,now+window,now,now,now+window,now,max);
    return !!row;
  }
  async challenge() {
    return await this.transaction(async () => {
      let value;
      for (let i = 0; i < 20; i++) {
        value = code();
        if ((await this.db.prepare('INSERT OR IGNORE INTO issued_codes VALUES(?)').run(hash(value))).changes) break;
        value = null;
      }
      if (!value) throw Error('Unable to generate code');
      const browser = token(),
        now = this.now();
      await this.db.prepare('INSERT INTO challenges(hash,browser,expires,accepted,terms,privacy) VALUES(?,?,?,?,?,?)').run(hash(value), hash(browser), now + 600000, now, VERSION, VERSION);
      return {
        code: value,
        browser,
        expires: now + 600000
      };
    });
  }
  async verify(value, uuid, name) {
    return await this.transaction(async () => {
      const row = await this.db.prepare('SELECT * FROM challenges WHERE hash=?').get(hash(value));
      if (!row || row.expires <= this.now() || row.consumed) return false;
      if (row.uuid) return row.uuid === uuid;
      await this.db.prepare('INSERT INTO users(uuid,name,created,discount) VALUES(?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name').run(uuid, name, this.now(), 'WELCOME-' + randomBytes(5).toString('hex').toUpperCase());
      await this.db.prepare('UPDATE challenges SET uuid=? WHERE hash=? AND uuid IS NULL').run(uuid, hash(value));
      return true;
    });
  }
  async poll(browser) {
    if(!browser)return {expired:true};
    return await this.transaction(async () => {
      const row = await this.db.prepare('SELECT * FROM challenges WHERE browser=?').get(hash(browser || ''));
      if (!row || row.expires <= this.now() || row.consumed) return {
        expired: true
      };
      if (!row.uuid) return {
        pending: true
      };
      const session = token();
      await this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session), row.uuid, this.now() + 30 * 86400000);
      await this.db.prepare('UPDATE challenges SET consumed=1 WHERE hash=?').run(row.hash);
      await this.db.prepare('INSERT INTO consent VALUES(?,?,?,?)').run(row.uuid, row.accepted, row.terms, row.privacy);
      return {
        session,
        user: await this.user(row.uuid)
      };
    });
  }
  async session(t) {
    if(!t)return null;
    const row = await this.db.prepare('SELECT uuid FROM sessions WHERE hash=? AND expires>?').get(hash(t || ''), this.now());
    return row ? await this.user(row.uuid) : null;
  }
  async logout(t) {
    await this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(t || ''));
  }
  async user(uuid) {
    const u = await this.db.prepare('SELECT * FROM users WHERE uuid=?').get(uuid);
    if (!u) return null;
    const spent = await this.db.prepare("SELECT 1 FROM orders WHERE uuid=? AND discounted=1 AND status IN ('paid','delivered','refunded')").get(uuid);
    return {
      uuid: u.uuid,
      name: u.name,
      plusUntil: u.plus_until,
      discountCode: spent ? null : u.discount,
      orders: (await this.db.prepare('SELECT id,days,amount,status FROM orders WHERE uuid=? ORDER BY created DESC LIMIT 15').all(uuid)).map(o => ({
        ...o,
        status: o.status === 'creating' ? 'pending' : o.status
      }))
    };
  }
  async nonce(value) {
    return !!(await this.db.prepare('INSERT OR IGNORE INTO nonces VALUES(?,?)').run(value, this.now() + 300000)).changes;
  }
  async heartbeat(payload) {
    await this.db.prepare('INSERT INTO server_status VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,received=excluded.received').run(JSON.stringify(payload), this.now());
  }
  async status(address, bedrockPort) {
    const row = await this.db.prepare('SELECT * FROM server_status WHERE id=1').get();
    if (!row) return {
      state: 'unavailable',
      online: null,
      max: null,
      address: address || null,
      bedrockPort,
      checkedAt: null
    };
    const p = JSON.parse(row.payload);
    const fresh = this.now() - row.received <= 90000;
    return {
      state: fresh ? p.online ? 'online' : 'offline' : 'stale',
      online: fresh && p.online ? p.players : null,
      max: fresh ? p.max : null,
      address: address || null,
      bedrockPort,
      checkedAt: row.received,
      version: p.version
    };
  }
  async order(uuid, days, discountCode) {
    return await this.transaction(async () => {
      if (!Object.hasOwn(PRICES, days)) throw Error('Choose a valid Nugget+ duration.');
      const u = await this.db.prepare('SELECT * FROM users WHERE uuid=?').get(uuid);
      const discounted = !!discountCode;
      if (discounted && discountCode !== u.discount) throw Error('That discount does not belong to this account.');
      if (discounted) {
        const old = await this.db.prepare('SELECT * FROM orders WHERE uuid=? AND discounted=1').get(uuid);
        if (old) {
          if (['paid', 'delivered', 'refunded'].includes(old.status)) throw Error('Your welcome discount has already been used.');
          if (old.days !== days) throw Error(`Your discount is reserved for the ${old.days}-day checkout. Complete or retry that plan.`);
          return old;
        }
      }
      const old = await this.db.prepare("SELECT * FROM orders WHERE uuid=? AND days=? AND discounted=? AND status IN ('creating','pending') ORDER BY created DESC LIMIT 1").get(uuid, days, Number(discounted));
      if (old) return old;
      const id = randomBytes(16).toString('hex');
      await this.db.prepare('INSERT INTO orders(id,uuid,days,amount,discounted,created,consented) VALUES(?,?,?,?,?,?,?)').run(id, uuid, days, discounted ? Math.round(PRICES[days] * .9) : PRICES[days], Number(discounted), this.now(), this.now());
      return await this.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    });
  }
  async attach(id, providerId) {
    await this.db.prepare("UPDATE orders SET provider_id=?,status='pending' WHERE id=? AND provider_id IS NULL AND status='creating'").run(providerId, id);
  }
  async captured(payment) {
    return await this.transaction(async () => {
      const o = await this.db.prepare('SELECT * FROM orders WHERE provider_id=?').get(payment.order_id);
      if (!o || payment.status !== 'captured' || payment.currency !== 'USD' || payment.amount !== o.amount || !/^pay_[a-zA-Z0-9]+$/.test(payment.id)) throw Error('Payment does not match a pending order.');
      if (['paid', 'delivered', 'refunded'].includes(o.status)) {
        if (o.payment_id !== payment.id) throw Error('Order was settled with another payment');
        return o;
      }
      await this.db.prepare("UPDATE orders SET status='paid',payment_id=? WHERE id=?").run(payment.id, o.id);
      return await this.db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
    });
  }
  async deliveries() {
    return await this.db.prepare("SELECT id,uuid,days FROM orders WHERE status='paid' ORDER BY created LIMIT 25").all();
  }
  async acknowledge(id, uuid, until) {
    return await this.transaction(async () => {
      const o = await this.db.prepare('SELECT * FROM orders WHERE id=? AND uuid=?').get(id, uuid);
      if (!o || !['paid', 'delivered'].includes(o.status)) throw Error('Delivery not found');
      if (o.status === 'delivered') return;
      await this.db.prepare("UPDATE orders SET status='delivered',delivery_until=?,delivered=? WHERE id=?").run(until, this.now(), id);
      await this.db.prepare('UPDATE users SET plus_until=MAX(plus_until,?) WHERE uuid=?').run(until, uuid);
    });
  }
  async clean() {
    await this.db.prepare('DELETE FROM sessions WHERE expires<?').run(this.now());
    await this.db.prepare('DELETE FROM challenges WHERE expires<?').run(this.now() - 86400000);
    await this.db.prepare('DELETE FROM nonces WHERE expires<?').run(this.now());
    await this.db.prepare('DELETE FROM rate_limits WHERE expires<?').run(this.now());
  }
  async close() {
    return await this.db.close();
  }
}
