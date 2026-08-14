const { getFirestore, serverTimestamp } = require('../firestore');

class MojidasUserStore {
  async recordLogin(user) {
    const document = getFirestore().collection('mojidasUsers').doc(user.uid);
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
