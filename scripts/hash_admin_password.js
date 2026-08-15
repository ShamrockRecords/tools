#!/usr/bin/env node

const readline = require('readline');
const { createAdminPasswordHash } = require('../modules/auth/admin_credentials');

function readPassword(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error('対話可能なターミナルで実行してください。'));
      return;
    }

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let password = '';
    const onData = (character) => {
      if (character === '\u0003') {
        process.stdout.write('\n');
        cleanup();
        reject(new Error('中断しました。'));
        return;
      }

      if (character === '\r' || character === '\n') {
        process.stdout.write('\n');
        cleanup();
        resolve(password);
        return;
      }

      if (character === '\u007f' || character === '\b') {
        password = password.slice(0, -1);
        return;
      }

      password += character;
    };

    function cleanup() {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on('data', onData);
  });
}

async function main() {
  const password = await readPassword('新しい管理者パスワード（8文字以上）: ');
  const confirmation = await readPassword('確認のためもう一度入力: ');

  if (password !== confirmation) {
    throw new Error('パスワードが一致しません。');
  }

  const passwordHash = createAdminPasswordHash(password);
  console.log('\nADMIN_PASSWORD_HASH に次の値を設定してください。');
  console.log(passwordHash);
}

main().catch((error) => {
  readline.clearLine(process.stdout, 0);
  console.error(error.message);
  process.exitCode = 1;
});
