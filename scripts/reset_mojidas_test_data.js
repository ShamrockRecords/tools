#!/usr/bin/env node
'use strict';

const path = require('path');
const firebaseAdmin = require('firebase-admin');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { mojidasCollectionPath, mojidasRootPath } = require('../modules/mojidas_firestore');

const legacyCollections = [
  'mojidasUsers',
  'emailVerificationChallenges',
  'creditGrants',
  'creditReservations',
  'usageLedger',
];
const namespacedCollections = [
  'users',
  'emailVerificationChallenges',
  'creditGrants',
  'creditReservations',
  'usageLedger',
];
const shouldConfirm = process.argv.includes('--confirm');
const shouldDeleteAllAuthUsers = process.argv.includes('--all-auth-users');

async function main() {
  initializeFirebaseAdmin();
  const firestore = firebaseAdmin.firestore();
  const collectionPaths = [
    ...legacyCollections,
    ...namespacedCollections.map(mojidasCollectionPath),
  ];
  const snapshots = new Map();
  const mojidasUserIDs = new Set();

  for (const collectionPath of collectionPaths) {
    const snapshot = await firestore.collection(collectionPath).get();
    snapshots.set(collectionPath, snapshot);
    for (const document of snapshot.docs) {
      const data = document.data() || {};
      if (typeof data.userID === 'string' && data.userID) mojidasUserIDs.add(data.userID);
      if (typeof data.uid === 'string' && data.uid) mojidasUserIDs.add(data.uid);
      if (
        collectionPath === 'mojidasUsers'
        || collectionPath === mojidasCollectionPath('users')
        || collectionPath.endsWith('/emailVerificationChallenges')
        || collectionPath === 'emailVerificationChallenges'
      ) {
        mojidasUserIDs.add(document.id);
      }
    }
  }

  const allAuthUserIDs = shouldDeleteAllAuthUsers ? await listAllAuthUserIDs() : [];
  const authUserIDs = shouldDeleteAllAuthUsers ? allAuthUserIDs : [...mojidasUserIDs];
  const counts = Object.fromEntries(
    [...snapshots].map(([collectionPath, snapshot]) => [collectionPath, snapshot.size])
  );

  console.log(JSON.stringify({
    mode: shouldConfirm ? 'delete' : 'dry-run',
    firestoreRoot: mojidasRootPath(),
    firestoreDocumentCounts: counts,
    associatedMojidasAuthUsers: mojidasUserIDs.size,
    authenticationUsersToDelete: authUserIDs.length,
    deletesAllAuthenticationUsers: shouldDeleteAllAuthUsers,
  }, null, 2));

  if (!shouldConfirm) {
    console.log('No data was deleted. Add --confirm to execute.');
    return;
  }

  for (const collectionPath of legacyCollections) {
    await deleteCollection(firestore.collection(collectionPath));
  }

  const rootDocument = firestore.doc(mojidasRootPath());
  await deleteDocumentTree(rootDocument);
  await deleteAuthenticationUsers(authUserIDs);
  await rootDocument.set({
    service: 'Mojidas',
    environment: mojidasRootPath().split('/')[1],
    schemaVersion: 1,
    initializedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(JSON.stringify({
    deletedFirestoreDocuments: Object.values(counts).reduce((total, count) => total + count, 0),
    deletedAuthenticationUsers: authUserIDs.length,
    initializedFirestoreRoot: mojidasRootPath(),
  }, null, 2));
}

function initializeFirebaseAdmin() {
  if (firebaseAdmin.apps.length) return;
  const raw = String(process.env.FIREBASE_ADMIN_CREDENTIALS || '').trim();
  if (!raw) throw new Error('FIREBASE_ADMIN_CREDENTIALS is not configured.');
  const candidates = [raw];
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  if (decoded.startsWith('{')) candidates.unshift(decoded);
  let credential;
  for (const candidate of candidates) {
    try {
      credential = JSON.parse(candidate);
      break;
    } catch (_error) {
      // Try the next representation.
    }
  }
  if (!credential) throw new Error('FIREBASE_ADMIN_CREDENTIALS is invalid.');
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(credential),
    projectId: process.env.FIREBASE_PROJECT_ID || credential.project_id,
  });
}

async function listAllAuthUserIDs() {
  const ids = [];
  let pageToken;
  do {
    const page = await firebaseAdmin.auth().listUsers(1000, pageToken);
    ids.push(...page.users.map((user) => user.uid));
    pageToken = page.pageToken;
  } while (pageToken);
  return ids;
}

async function deleteAuthenticationUsers(userIDs) {
  for (let index = 0; index < userIDs.length; index += 1000) {
    const batch = userIDs.slice(index, index + 1000);
    if (!batch.length) continue;
    const result = await firebaseAdmin.auth().deleteUsers(batch);
    if (result.failureCount > 0) {
      const details = result.errors.map((item) => ({
        index: index + item.index,
        message: item.error.message,
      }));
      throw new Error(`Failed to delete Authentication users: ${JSON.stringify(details)}`);
    }
  }
}

async function deleteDocumentTree(document) {
  const subcollections = await document.listCollections();
  for (const collection of subcollections) await deleteCollection(collection);
  await document.delete();
}

async function deleteCollection(collection) {
  while (true) {
    const snapshot = await collection.limit(200).get();
    if (snapshot.empty) return;
    for (const document of snapshot.docs) await deleteDocumentTree(document.ref);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
