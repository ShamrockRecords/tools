const { domainToASCII } = require('url');

// 法人性は管理者が確認する。共用メールの拒否はその補助であり自動承認ではない。
const SHARED_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'ymail.com',
  'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com', 'live.jp',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'msn.com', 'mail.com', 'gmx.com', 'qq.com', '163.com', '126.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp',
]);

function normalizeDomain(value) {
  if (typeof value !== 'string' || value.length > 253) return null;
  const domain = domainToASCII(value.trim().toLowerCase());
  if (!domain || domain.length > 253 || !domain.includes('.')
      || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || /^\d+(\.\d+)+$/.test(domain)) return null;
  return domain;
}

function isSharedDomain(domain) {
  return [...SHARED_DOMAINS].some(shared => domain === shared || domain.endsWith(`.${shared}`));
}

module.exports = { normalizeDomain, isSharedDomain };
