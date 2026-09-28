const crypto = require('crypto');
const { mojidasCollection } = require('../mojidas_firestore');
const memberID = (domain, uid) => crypto.createHash('sha256').update(`${domain}:${uid}`).digest('hex');
const memberRef = (db, domain, uid) => mojidasCollection(db, 'corporateMembers').doc(memberID(domain, uid));
const memberEnabled = (settings, member) => typeof member?.enabled === 'boolean' ? member.enabled : settings.autoEnableMembers !== false;
// 初回だけ現在の設定を固定する。設定変更・再ログインで既存の状態を上書きしない。
async function enrollMember(db, domain, uid, now = Date.now, portalID) {
  if (!uid) return null;
  return db.runTransaction(async tx => {
    const settings = await tx.get(mojidasCollection(db, 'corporateDomains').doc(domain));
    if (!settings.exists || (portalID && settings.data().portalAccountID !== portalID)) throw new Error('対象ドメインを確認してください。');
    const ref = memberRef(db, domain, uid), existing = await tx.get(ref);
    if (existing.exists) return existing.data();
    const member = { domain, userID: uid, enabled: settings.data().autoEnableMembers !== false, createdAt: now() };
    tx.set(ref, member);
    return member;
  });
}
async function membershipAllowed(db, domain, uid, settings, tx) {
  if (!uid) return settings.autoEnableMembers !== false;
  const ref = memberRef(db, domain, uid);
  const snapshot = await (tx ? tx.get(ref) : ref.get());
  return memberEnabled(settings, snapshot.exists ? snapshot.data() : null);
}
module.exports = { memberRef, memberEnabled, membershipAllowed, enrollMember };
