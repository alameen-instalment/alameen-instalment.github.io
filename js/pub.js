// Public (no login) read access for the customer catalog page. Only catalog items marked "show" and seller contact are readable.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './config.js';

const db = getFirestore(initializeApp(firebaseConfig));

export async function loadShop(sellerKey) {
  const [items, seller] = await Promise.all([
    getDocs(query(collection(db, 'catalog'), where('show', '==', true))),
    sellerKey ? getDoc(doc(db, 'shopSellers', sellerKey)) : Promise.resolve(null),
  ]);
  return { items: items.docs.map((d) => ({ id: d.id, ...d.data() })), seller: seller && seller.exists() ? seller.data() : null };
}

export async function loadPhoto(id) {
  const d = await getDoc(doc(db, 'catalogPhotos', id));
  return d.exists() ? d.data().data : null;
}
