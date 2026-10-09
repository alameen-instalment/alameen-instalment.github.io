// Customer catalog: read-only list of items with photo, description, price and availability. Never shows cost.
import { loadShop, loadPhoto } from './pub.js';
import { APP_NAME } from './config.js';

const ML = {
  'All': 'എല്ലാം', 'Available': 'ലഭ്യമാണ്', 'Sold out': 'തീർന്നു', 'Ask on WhatsApp': 'WhatsApp-ൽ ചോദിക്കുക',
  'Crockery': 'പാത്രങ്ങൾ', 'Furniture': 'ഫർണിച്ചർ', 'Electronics': 'ഇലക്ട്രോണിക്സ്', 'Carpet/Mat': 'കാർപെറ്റ്/മാറ്റ്', 'Others': 'മറ്റുള്ളവ',
  'Instalment available': 'തവണ വ്യവസ്ഥയിൽ ലഭിക്കും', 'No items to show right now.': 'ഇപ്പോൾ കാണിക്കാൻ സാധനങ്ങളില്ല.',
  'Could not load. Check internet and try again.': 'ലോഡ് ആയില്ല. ഇന്റർനെറ്റ് നോക്കി വീണ്ടും ശ്രമിക്കുക.', 'Search': 'തിരയുക',
  'I would like to know about': 'ഈ സാധനത്തെ പറ്റി അറിയണം', 'Price': 'വില',
};
let lang = (() => { try { return localStorage.getItem('shopLang') || 'ml'; } catch { return 'ml'; } })();
const t = (k) => (lang === 'ml' && ML[k]) || k;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const wa = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.length === 11 && d[0] === '0' ? '91' + d.slice(1) : d; };
const $ = (s) => document.querySelector(s);
const key = new URLSearchParams(location.search).get('s') || '';
let data = null, cat = 'all', q = '';
const photos = {};

function draw() {
  document.documentElement.lang = lang;
  $('#lang').textContent = lang === 'ml' ? 'English' : 'മലയാളം';
  const seller = data.seller;
  $('#who').textContent = seller?.name ? `${seller.name} · ${t('Instalment available')}` : t('Instalment available');
  const items = data.items.filter((i) => (cat === 'all' || (i.category || 'Others') === cat) && (!q || i.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0) || a.name.localeCompare(b.name));
  const cats = [...new Set(data.items.map((i) => i.category || 'Others'))].sort();
  $('#cats').innerHTML = [['all', t('All'), data.items.length], ...cats.map((c) => [c, t(c), data.items.filter((i) => (i.category || 'Others') === c).length])]
    .map(([k, l, n]) => `<button class="fchip ${k === cat ? 'on' : ''}" data-c="${esc(k)}">${esc(l)} <small>${n}</small></button>`).join('');
  document.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { cat = b.dataset.c; draw(); }));
  $('#grid').innerHTML = items.map((i) => {
    const msg = `${APP_NAME}: ${t('I would like to know about')} — ${i.name} (${money(i.price)})`;
    return `<div class="shopcard ${i.available ? '' : 'sold'}">
      ${i.hasPhoto ? `<img data-ph="${esc(i.id)}" alt="${esc(i.name)}" ${photos[i.id] ? `src="${photos[i.id]}"` : ''}>` : '<div class="noimg">🛍️</div>'}
      <div class="in"><b>${esc(i.name)}</b>${i.description ? `<p>${esc(i.description)}</p>` : ''}
        <span class="price">${money(i.price)}</span>
        <span class="tag ${i.available ? 'ok' : 'no'}">${i.available ? t('Available') : t('Sold out')}</span>
        ${seller?.wa ? `<a class="btn wa" href="https://wa.me/${wa(seller.wa)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${t('Ask on WhatsApp')}</a>` : ''}</div></div>`;
  }).join('') || `<p class="muted">${t('No items to show right now.')}</p>`;
  document.querySelectorAll('img[data-ph]:not([src])').forEach((img) => {
    const id = img.dataset.ph;
    loadPhoto(id).then((src) => { if (src) { photos[id] = src; img.src = src; } }).catch(() => {});
  });
}

$('#lang').onclick = () => { lang = lang === 'ml' ? 'en' : 'ml'; try { localStorage.setItem('shopLang', lang); } catch {} draw(); };
$('#q').oninput = (e) => { q = e.target.value.toLowerCase().trim(); draw(); };
loadShop(key).then((d) => { data = d; $('#q').placeholder = t('Search'); draw(); })
  .catch((e) => { console.error(e); $('#grid').innerHTML = `<p class="muted">${t('Could not load. Check internet and try again.')}</p>`; });
