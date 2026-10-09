# Al Ameen Instalment — Setup and Operations

Installable web app (PWA) for stock, customer accounts, collections, expenses and reports.
Data lives in Firebase Firestore (free Spark plan, no card). Hosted on GitHub Pages.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `css/app.css` | App shell and styles |
| `js/app.js` | All screens |
| `js/logic.js` | Pricing, allocation and profit rules (unit-tested) |
| `js/db.js` | Firebase connection and offline-safe writes |
| `js/i18n.js` | English / Malayalam text |
| `js/holidays.js` | Kerala Government public holidays (2026). Add 2027 when published |
| `shop.html`, `js/shop.js`, `js/pub.js` | Public customer catalog (no login), `shop.html?s=<seller book key>` |
| `js/config.js` | Firebase project keys — **fill this in** |
| `firestore.rules` | Security rules — paste into Firebase console |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline cache and home-screen install |
| `test/` | Logic tests and browser test mock (not loaded by the app) |

## One-time setup

1. **Firebase project**: create project, enable Authentication → Email/Password, create Firestore in `asia-south1`, production mode.
2. **Admin login**: Authentication → Users → Add user `admin@alameen-instalment.app` with a password.
3. **Rules**: Firestore → Rules → replace everything with the contents of `firestore.rules` → Publish.
4. **Config**: copy the Web app `firebaseConfig` into `js/config.js`.
5. **Host**: push to GitHub repo `alameen-instalment`, Settings → Pages → Deploy from branch `main`, folder `/ (root)`. App URL: `https://<github-user>.github.io/alameen-instalment/`.
6. **First login** as `admin`: the app creates the admin profile and default settings (margin 100%, old balance margin 85%).
7. **Admin → Menu → Users**: create sellers (`razak`, `assainar`, `kareem`).
8. **Admin → Menu → App settings**: paste the Gemini API key (from aistudio.google.com) for bill reading.
9. On each phone: open the URL in Chrome → menu ⋮ → **Add to Home screen** / **Install app**.

## How the money works

- Selling price = cost × (1 + margin%). Price can be changed per item at sale time.
- Each customer can have several named accounts; each account is a running ledger.
- A collection pays the account's oldest open sale first (opening balance is oldest). The advance on a new sale pays that sale.
- Realised profit = collection × that sale's profit share. Old-book balances use the old balance margin (85% markup → 45.9% of each rupee).
- Payment modes: Cash, UPI, Scrap. Scrap = old metal/material taken instead of money; it lowers the balance and counts in realised profit, but is not cash in hand. Scrap is pooled company-wide; when the admin sells it, gain/loss = amount received − value credited, and cash received adds to company cash in hand.
- Returns: Good (back to stock) / Complaint (repair or supplier) / Damage (written off). If the customer is credited, the balance drops and a damaged item's cost is a company loss ("Damage loss").
- Void sale (admin): removes a wrong sale, its advance, puts items back in stock; money other collections had paid toward it moves to the account's other open items (or becomes credit).
- Seller net = realised profit − personal expenses. Company net = all realised profit − personal expenses − company expenses − damage loss + scrap gain.
- Changing the default margin offers to re-price all stock; past sales keep their price.
- Visits without payment (not at home / no money / promised date) never change money. A promised date becomes a reminder.
- Orders take no advance. "To buy" compares all sellers' pending orders with stock (no customer names). Delivering an order opens a prefilled sale.
- Holidays: Kerala holidays and admin events that fall on a route day show a card 2 days before; each seller moves the route to another date or cancels it for that week.

## Known limits (Phase 1)

- **New staff**: Admin → Users → Add seller. A new seller starts with no customers.
- **Handover**: Admin → Users → *Hand over to new person* moves a seller's whole book (customers, accounts, balances, history) to a new login from a chosen date. Reports before that date stay with the old seller.
- **Forgot password**: Admin → Users → *New login (forgot password)* — same person, new username; customers and reports unchanged.
- **Backups**: the free plan has no automatic backup. Admin → Menu → *Backup (Excel)* about once a week; keep the file in Google Drive.
- A handover moves a whole book to a brand-new login; one login cannot hold two books.
- Sales cannot be edited after saving; correct them with a Return (credited), or the admin can Void a sale that has no returns.
- PDFs are in English (Malayalam fonts are not embedded).
- Bill reading needs internet; everything else works offline and syncs later.
- When two phones sell the last unit offline, stock can go negative (shown with ⚠ to the admin).

## Releasing an update

Change files, bump `VERSION` in `sw.js`, push to `main`. Phones get the update the next time the app is opened online.
