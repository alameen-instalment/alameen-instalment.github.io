// Firebase setup and thin data helpers.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDoc, getDocs,
  setDoc, onSnapshot, query, where, writeBatch, increment, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, LOGIN_DOMAIN } from './config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export { collection, doc, getDoc, getDocs, setDoc, onSnapshot, query, where, writeBatch, increment, deleteField, onAuthStateChanged };

export const emailOf = (username) => `${String(username).trim().toLowerCase()}@${LOGIN_DOMAIN}`;
export const login = (username, password) => signInWithEmailAndPassword(auth, emailOf(username), password);
export const logout = () => signOut(auth);

export async function changeOwnPassword(current, next) {
  const u = auth.currentUser;
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
  await updatePassword(u, next);
}

/** Create a login without signing the admin out (uses a throwaway second app). */
export async function createLogin(username, password) {
  const tmp = initializeApp(firebaseConfig, 'tmp-' + Date.now());
  try {
    const cred = await createUserWithEmailAndPassword(getAuth(tmp), emailOf(username), password);
    return cred.user.uid;
  } finally {
    await signOut(getAuth(tmp)).catch(() => {});
    await deleteApp(tmp).catch(() => {});
  }
}

// Paths
export const sellerCol = (sid, name) => collection(db, 'sellers', sid, name);
export const sellerDoc = (sid, name, id) => doc(db, 'sellers', sid, name, id);
export const newId = (col) => doc(col).id;

/**
 * Commit without waiting for the server, so the app keeps working offline.
 * Writes land in the local cache at once and sync when the network returns.
 */
export function commit(batch, onError) {
  batch.commit().catch((e) => { console.error(e); onError && onError(e); });
}

/** Read docs from a query, falling back to cache when offline. */
export async function fetchAll(q) {
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function audit(batch, uid, entity, path, before, after) {
  const ref = doc(collection(db, 'auditLog'));
  batch.set(ref, { entity, path, before: before ?? null, after: after ?? null, by: uid, at: Date.now() });
}
