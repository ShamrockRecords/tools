const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SendGridMailer } = require('../modules/email/sendgrid_mailer');

const subject = 'パスワード再発行のお知らせ';
const body = (password) => `新しいパスワードを発行しました。\n\n新しいパスワード：${password}\n\n新しいパスワードで管理ツールにログインしてください。\nログインできない場合は、お手数ですが再度ご連絡ください。\n`;

// 引用符内のタブ・改行と二重引用符を扱うTSVパーサー。
function parseTsv(input) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === '\t' || c === '\n' || c === '\r')) {
      row.push(cell); cell = '';
      if (c !== '\t') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (quoted) throw new Error('TSVの引用符が閉じていません。');
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function recipients(input) {
  const [headers, ...rows] = parseTsv(input);
  const emailIndex = headers.indexOf('メールアドレス');
  const passwordIndex = headers.indexOf('列 1');
  if (emailIndex < 0 || passwordIndex < 0) throw new Error('メールアドレス／列 1が必要です。');
  const seen = new Map();
  for (const row of rows) {
    const email = (row[emailIndex] || '').trim();
    const password = row[passwordIndex] || '';
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email) || !password.trim() || /[\r\n\t]/.test(password)) {
      throw new Error('メールアドレスまたはパスワードが不正です。送信を中止します。');
    }
    const key = email.toLowerCase();
    if (seen.has(key) && seen.get(key).password !== password) throw new Error('同じ宛先に異なるパスワードがあります。');
    seen.set(key, { email, password });
  }
  if (!seen.size) throw new Error('宛先がありません。');
  return [...seen.values()];
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const args = process.argv.slice(2);
  if (!args[0] || args.some((arg, i) => i > 0 && arg !== '--send')) throw new Error('使い方: node scripts/send_password_reissue.js TSVパス [--send]');
  const input = fs.readFileSync(args[0], 'utf8');
  const targets = recipients(input);
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) throw new Error('SENDGRID_API_KEYとSENDGRID_FROM_EMAILが必要です。');
  console.log(`対象: ${targets.length}件\n件名: ${subject}\n\n${body('（各行の「列 1」の値）')}`);
  if (!args.includes('--send')) { console.log('プレビューのみ。メールは送信していません。'); return; }
  // 同じファイルの再実行を拒否。途中停止・結果不明でも自動再送しない。
  const digest = crypto.createHash('sha256').update(input).digest('hex');
  const logDir = path.join(__dirname, '..', 'logs', 'password-reissue');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${digest}.json`);
  const fd = fs.openSync(logPath, 'wx', 0o600);
  const state = { startedAt: new Date().toISOString(), total: targets.length, accepted: 0, status: 'sending', report: 'pending' };
  const save = () => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(state, null, 2), 0, 'utf8'); fs.fsyncSync(fd); };
  const mailer = new SendGridMailer();
  try {
    save();
    for (const target of targets) {
      await mailer.send({ to: target.email, subject, text: body(target.password) });
      state.accepted++; save();
    }
    state.status = 'accepted'; save();
  } catch (error) {
    state.status = 'stopped_check_required';
    state.errorCode = error.code || 'UNKNOWN'; save();
  }
  try {
    state.report = 'sending'; save();
    await mailer.send({
      to: process.env.SENDGRID_FROM_EMAIL,
      subject: 'パスワード再発行メールの送信結果',
      text: `パスワード再発行メールの送信処理結果です。\n\n対象：${state.total}件\nSendGrid受付済み：${state.accepted}件\n状態：${state.status === 'accepted' ? '全件受付済み' : '途中停止（送信結果の確認が必要）'}\n\n受付済みは配達完了を意味しません。\nアカウント名・パスワード・宛先一覧は記載していません。\n`,
    });
    state.report = 'accepted'; save();
  } catch (error) {
    state.report = 'check_required'; save();
  } finally { fs.closeSync(fd); }
  console.log(`SendGrid受付済み: ${state.accepted}/${state.total}件、報告: ${state.report}`);
  if (state.status !== 'accepted' || state.report !== 'accepted') process.exitCode = 1;
}

if (require.main === module) main().catch(() => {
  console.error('処理を中止しました。入力・環境設定・既存の送信記録を確認してください。同じTSVの再送は自動では行いません。');
  process.exitCode = 1;
});
module.exports = { parseTsv, recipients, body };
