const UDTALK_ROOT_COLLECTION = 'UDTalk';

function udtalkRootPath() {
  const environment = String(process.env.UDTALK_FIRESTORE_ENV || 'production').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(environment)) {
    throw new Error('UDTALK_FIRESTORE_ENVの形式が正しくありません。');
  }
  return `${UDTALK_ROOT_COLLECTION}/${environment}`;
}

function udtalkCollection(firestore, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('UDTalkのコレクション名が正しくありません。');
  return firestore.collection(`${udtalkRootPath()}/${name}`);
}

module.exports = { UDTALK_ROOT_COLLECTION, udtalkRootPath, udtalkCollection };
