const { CorporateBillingService } = require('../modules/billing/corporate_billing_service');

function options(args) {
  const result = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') result.execute = true;
    else if (arg === '--dry-run') result.execute = false;
    else if (arg === '--record-contracts') result.recordContracts = true;
    else if (['--first-month', '--domain', '--confirm-history-from'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      result[{ '--first-month': 'firstMonth', '--domain': 'domain', '--confirm-history-from': 'historyFrom' }[arg]] = args[++i];
    } else throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
  }
  if (Boolean(result.domain) !== Boolean(result.historyFrom) || (result.recordContracts && result.historyFrom)
    || (args.includes('--execute') && args.includes('--dry-run'))) throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
  return result;
}
async function main({ args = process.argv.slice(2), service, log = console.log } = {}) {
  try {
    const config = options(args), billing = service || new CorporateBillingService();
    let result;
    if (config.historyFrom) result = await billing.confirmHistory(config.domain, config.historyFrom, config.execute);
    else if (config.recordContracts) {
      if (config.execute) await billing.observeContracts();
      result = { execute: config.execute, action: 'record-contracts', note: '現在の契約条件を記録します。過去の条件は補完しません。' };
    } else result = await billing.run(config);
    log(JSON.stringify(result));
    return result.errors?.length ? 1 : 0;
  } catch (error) {
    // Stripe例外の本文には宛先等が含まれ得るため、コードだけを出力する。
    log(JSON.stringify({ error: { code: error.code || 'CORPORATE_BILLING_FAILED' } }));
    return 2;
  }
}
function initializeFirebase() {
  require('dotenv').config();
  const admin = require('../modules/firebase_admin');
  if (admin.apps.length) return;
  const raw = String(process.env.FIREBASE_ADMIN_CREDENTIALS || '').trim();
  let credentials;
  try { credentials = JSON.parse(raw); }
  catch (_) { credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: process.env.FIREBASE_PROJECT_ID });
}
if (require.main === module) {
  try { options(process.argv.slice(2)); initializeFirebase(); main().then(code => { process.exitCode = code; }); }
  catch (_) { console.error('法人請求の引数またはFirebase設定を確認してください。'); process.exitCode = 2; }
}
module.exports = { main, options };
