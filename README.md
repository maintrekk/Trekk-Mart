# Trekk Mart Backend

Express API for Trekk Mart. Deploy this folder as a Node.js service (for example, Render).

## Deploy
- Build command: `npm install`
- Start command: `npm start`
- Node.js: 18 or newer

## Required environment variables
- `FIREBASE_SERVICE_ACCOUNT`: Firebase service-account JSON on one line
- `ADMIN_EMAILS`: comma-separated admin email addresses
- `ALLOWED_ORIGINS`: comma-separated frontend origins (supports `https://*.netlify.app`). Live: `https://trekk-mart.trekk.com.ng`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (your first Cloudinary account)
- `CLOUDINARY_ACCOUNTS` (optional): more accounts as one-line JSON, `[{"cloud":"name2","key":"...","secret":"..."},{"cloud":"name3","key":"...","secret":"..."}]`. New uploads are shared between all accounts and skip any account that is 90% full. Old images stay where they are.
- `SQUAD_SECRET_KEY` for Squad payment verification/webhook
- `SQUAD_ENV=sandbox` for sandbox, otherwise live API is used

Update `js/config.js` in the frontend with this backend's deployed URL and the Squad **public** key. Keep all secret keys in backend environment variables only.

## Commands
- `npm install`
- `npm run check`
- `npm test`
- `npm start`

See the original README and `server.js` for routes and business rules.
