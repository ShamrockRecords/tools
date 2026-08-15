const MOJIDAS_ROOT_COLLECTION = 'Mojidas';
const DEFAULT_MOJIDAS_ENVIRONMENT = 'production';

function mojidasEnvironment() {
  const value = String(
    process.env.MOJIDAS_FIRESTORE_ENV || DEFAULT_MOJIDAS_ENVIRONMENT
  ).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('MOJIDAS_FIRESTORE_ENV contains unsupported characters.');
  }
  return value;
}

function mojidasRootPath() {
  return `${MOJIDAS_ROOT_COLLECTION}/${mojidasEnvironment()}`;
}

function mojidasCollectionPath(name) {
  const collectionName = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(collectionName)) {
    throw new Error('Mojidas collection name contains unsupported characters.');
  }
  return `${mojidasRootPath()}/${collectionName}`;
}

function mojidasCollection(firestore, name) {
  return firestore.collection(mojidasCollectionPath(name));
}

module.exports = {
  DEFAULT_MOJIDAS_ENVIRONMENT,
  MOJIDAS_ROOT_COLLECTION,
  mojidasCollection,
  mojidasCollectionPath,
  mojidasEnvironment,
  mojidasRootPath,
};
