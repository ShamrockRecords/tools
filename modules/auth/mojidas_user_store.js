const { getFirestore, serverTimestamp } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

class MojidasUserStore {
  constructor({ firestoreProvider = getFirestore, timestamp = serverTimestamp } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.timestamp = timestamp;
  }

  async recordClientInfo(uid, platform, version) {
    // 利用者申告の診断情報。認証・利用可否の判定には使わない。
    if (!['macos', 'windows'].includes(platform) || typeof version !== 'string'
        || version.length > 40
        || !(platform === 'macos' ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+\.\d+$/).test(version)) return;
    await mojidasCollection(this.firestoreProvider(), 'users').doc(uid).set({
      appClients: { [platform]: { version, lastSeenAt: this.timestamp() } },
    }, { merge: true });
  }

  async recordLogin(user) {
    const document = mojidasCollection(getFirestore(), 'users').doc(user.uid);
    const snapshot = await document.get();
    const data = {
      email: user.email || null,
      emailVerified: Boolean(user.emailVerified),
      status: user.disabled ? 'disabled' : 'active',
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (!snapshot.exists) {
      data.createdAt = user.metadata && user.metadata.creationTime
        ? new Date(user.metadata.creationTime)
        : serverTimestamp();
    }

    await document.set(data, { merge: true });
  }
}

module.exports = new MojidasUserStore();
module.exports.MojidasUserStore = MojidasUserStore;
