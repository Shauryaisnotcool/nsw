import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
export const UPI_PAYEE = '9766391181@fam';
// This is a payment request, not a bank gateway. Only trusted reconciliation can settle it.
export class PostgresUpi {
  constructor(store) {
    this.store = store;
  }
  async create(order, quote) {
    const s = this.store,
      now = s.now();
    if (!Number.isFinite(quote.rate) || quote.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date) || !Number.isFinite(Date.parse(quote.date)) || now - Date.parse(quote.date) > 7 * 86400000 || Date.parse(quote.date) > now + 86400000) throw Error('A current exchange rate is unavailable.');
    return await s.transaction(async () => {
      const fresh = await s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
      if (!fresh || !['creating', 'pending'].includes(fresh.status) || fresh.provider_id && !fresh.provider_id.startsWith('upi_')) throw Error('This order already uses another payment method.');
      await s.db.prepare('UPDATE upi_attempts SET cancelled=1 WHERE order_id=? AND settled IS NULL').run(order.id);
      const id = randomBytes(16).toString('hex'),
        amount = Math.round(fresh.amount * quote.rate);
      await s.db.prepare('INSERT INTO upi_attempts(id,order_id,amount,rate,rate_date,created,expires) VALUES(?,?,?,?,?,?,?)').run(id, order.id, amount, quote.rate, quote.date, now, now + 180000);
      await s.db.prepare("UPDATE orders SET status='pending',provider_id=? WHERE id=?").run('upi_' + order.id, order.id);
      return await this.get(id, order.uuid);
    });
  }
  async get(id, uuid) {
    const a = await this.store.db.prepare('SELECT a.*,o.uuid,o.days,o.status FROM upi_attempts a JOIN orders o ON o.id=a.order_id WHERE a.id=? AND o.uuid=?').get(id, uuid);
    if (!a) return null;
    const state = a.settled ? 'paid' : a.cancelled ? 'cancelled' : a.expires <= this.store.now() ? 'expired' : 'pending';
    const result = {
      id: a.id,
      orderId: a.order_id,
      days: a.days,
      amount: a.amount,
      currency: 'INR',
      payee: UPI_PAYEE,
      expires: a.expires,
      serverTime: this.store.now(),
      state,
      rate: a.rate,
      rateDate: a.rate_date
    };
    if (state === 'pending') result.uri = 'upi://pay?' + new URLSearchParams({
      pa: UPI_PAYEE,
      pn: 'Nugget SMP',
      tr: a.id,
      tn: 'Nugget+ ' + a.days + 'd ' + a.id,
      am: (a.amount / 100).toFixed(2),
      cu: 'INR'
    });
    return result;
  }
  async cancel(id, uuid) {
    await this.store.db.prepare('UPDATE upi_attempts SET cancelled=1 WHERE id=? AND settled IS NULL AND order_id IN (SELECT id FROM orders WHERE uuid=?)').run(id, uuid);
    return await this.get(id, uuid);
  }
  // CLI only: an operator must first match the actual bank credit, amount and checkout reference.
  // Browser claims, screenshots and a submitted UTR never authorize rank delivery.
  async reconcile({
    id,
    reference,
    amount,
    received,
    acceptLate = false
  }) {
    if (!/^[A-Za-z0-9-]{6,80}$/.test(reference || '') || !Number.isSafeInteger(amount) || !Number.isSafeInteger(received)) throw Error('Supply the bank reference, exact paise amount and received timestamp.');
    const s = this.store;
    return await s.transaction(async () => {
      const a = await s.db.prepare('SELECT * FROM upi_attempts WHERE id=?').get(id);
      if (!a || a.amount !== amount || received < a.created || received > s.now() + 60000) throw Error('Bank credit does not match this checkout.');
      if (a.settled) {
        if (a.bank_reference !== reference || a.received !== received) throw Error('Already reconciled with another credit.');
        return a.order_id;
      }
      const o = await s.db.prepare('SELECT * FROM orders WHERE id=?').get(a.order_id);
      if (!['creating', 'pending'].includes(o.status)) throw Error('Order already paid. Review this extra credit for refund.');
      const late = !!a.cancelled || received >= a.expires;
      if (late && !acceptLate) throw Error('Expired or cancelled checkout: review the credit and explicitly accept late settlement or refund it.');
      await s.db.prepare('UPDATE upi_attempts SET bank_reference=?,settled=?,received=?,late_accepted=? WHERE id=?').run(reference, s.now(), received, Number(late), id);
      await s.db.prepare("UPDATE orders SET status='paid',payment_id=? WHERE id=?").run('bank_' + reference, a.order_id);
      return a.order_id;
    });
  }
  async image(attempt) {
    return {
      ...attempt,
      qr: attempt.uri ? await QRCode.toDataURL(attempt.uri, {
        width: 360,
        margin: 2,
        errorCorrectionLevel: 'M'
      }) : null
    };
  }
}
let cached;
export async function exchangeRate() {
  if (cached && Date.now() - cached.fetched < 3600000) return cached;
  const response = await fetch('https://api.frankfurter.dev/v2/rate/USD/INR', {
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Error('Exchange rate unavailable');
  const q = await response.json();
  if (q.base !== 'USD' || q.quote !== 'INR') throw Error('Incorrect exchange rate');
  cached = {
    rate: q.rate,
    date: q.date,
    fetched: Date.now()
  };
  return cached;
}
