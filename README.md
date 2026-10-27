# Trekk Mart backend

## Setup (about 20 minutes)
1. **New Firebase project** (separate from FoodRunner; this becomes TrekkGrid's user base later).
   Enable Google sign-in and Firestore. Paste `firestore.rules` into Firestore > Rules.
   Add your domain under Authentication > Settings > Authorized domains.
2. Project settings > Service accounts > Generate new private key. Put the JSON, on one line, in `FIREBASE_SERVICE_ACCOUNT`.
3. **Cloudinary**: create an unsigned upload preset (Settings > Upload). Set `CLOUDINARY_CLOUD_NAME`.
4. **Render**: new Web Service from this folder. Build `npm install`, start `npm start`. Add the env vars from `.env.example`.
5. **Squad**: use your secret key. Start with `SQUAD_ENV=sandbox` and the sandbox keys.

## Check before going live
- Squad verify returns the amount in kobo; `settle()` compares it to `amountKobo`. Mirror whatever your FoodRunner `/squad/verify` does, and run one sandbox payment to confirm.
- Squad allows one webhook URL per account (check your dashboard). If FoodRunner already uses it, the webhook will not reach this server. That is fine: the browser calls `/api/slots/verify` right after payment. If you want a safety net, have FoodRunner's webhook forward refs starting with `TM_` to this backend's `/api/squad/webhook`.
- Render free tier sleeps. Ping `GET /` when the dashboard page opens (same trick as FoodRunner checkout).

## Money rules live at the top of server.js
`FREE_SLOTS`, `UGC_BONUS`, `PACKS`. Slots count ACTIVE products only, so marking an item sold frees a slot.

## Endpoints
Vendor: `POST /api/vendors/register`, `GET|PATCH /api/vendors/me`, `POST /api/products`, `POST /api/products/:id/status`
Buyer: `POST /api/orders` (prices from DB, logs order, returns WhatsApp links)
Slots: `GET /api/slots/packs`, `POST /api/slots/init`, `POST /api/slots/verify`, `POST /api/slots/request`, `POST /api/squad/webhook`
Admin (ADMIN_EMAILS only): `/api/admin/stats|vendors|requests|payments`, `.../vendors/:id/review`, `.../requests/:id/decision`
