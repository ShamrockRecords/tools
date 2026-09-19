const { mojidasCollection } = require('../mojidas_firestore');
// 表示中の月だけでなく全期間・旧販売店も含めて確認する。
async function deletionState(db, domain, read = ref => ref.get()) {
  const collection = name => mojidasCollection(db, name);
  const ledger = await read(collection('corporateUsageLedger').where('domain', '==', domain));
  const months = await read(collection('corporateUsageMonths').where('domain', '==', domain));
  const reservations = await read(collection('corporateReservations').where('corporate.domain', '==', domain));
  const used = ledger.docs.some(doc => doc.data().milliseconds !== 0)
    || months.docs.some(doc => ['realtime', 'mediaFile', 'formalTranslation'].some(key => (doc.data()[key] || 0) !== 0));
  const active = reservations.docs.some(doc => ['held', 'consuming'].includes(doc.data().status));
  return { canDelete: !used && !active, ledger, months };
}
module.exports = { deletionState };
