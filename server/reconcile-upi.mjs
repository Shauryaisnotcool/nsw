// Run only after checking the receiving bank's statement, never from a customer-provided receipt.
import {Store} from './store.mjs';
import {UpiCheckout} from './upi.mjs';
const [id,reference,amount,iso,...flags]=process.argv.slice(2);
if(!id||!reference||!amount||!iso||!flags.includes('--bank-credit-verified')){
 console.error('Usage: npm run reconcile:upi -- ATTEMPT_ID BANK_REFERENCE AMOUNT_PAISE RECEIVED_ISO --bank-credit-verified [--accept-late]');process.exit(1);
}
const store=new Store(process.env.DATABASE_PATH||'data/nugget-website.db');
try{const order=new UpiCheckout(store).reconcile({id,reference,amount:Number(amount),received:Date.parse(iso),acceptLate:flags.includes('--accept-late')});console.log('Verified credit recorded. Rank delivery queued for order '+order);}finally{store.close();}
