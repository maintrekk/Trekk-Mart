"use strict";
/* Trekk Mart backend. Deploy on Render. Every trusted action lives here:
   vendor signup, product limits, order logging, Squad slot payments, admin. */
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const env = process.env;
let db = null;
if (env.FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  db = admin.firestore();
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT is not set: serving the storefront without local API data.");
}

/* ---------- business rules: edit these, nothing else ---------- */
const FREE_SLOTS = 25;
const UGC_BONUS = 10; // free slots for an approved TikTok/Reel
const PACKS = {
  p15: { slots: 15, amount: 1000 },
  p25: { slots: 25, amount: 1500 },
  p60: { slots: 60, amount: 3000 },
  p150: { slots: 150, amount: 6000 }
};
const DEFAULT_CATS = [
  { name: "Perfumes", emoji: "🧴", color: "#F3E6F8" }, { name: "Watches", emoji: "⌚", color: "#E3EEF8" }, { name: "Skincare", emoji: "🧼", color: "#FCEBDD" },
  { name: "Thrifted wears", emoji: "👕", color: "#E4F4EC" }, { name: "Luxury wears", emoji: "👜", color: "#F6EFD9" }, { name: "Shoes", emoji: "👟", color: "#FDE5E1" },
  { name: "Gadgets", emoji: "🎧", color: "#E1F4F7" }, { name: "Hair & beauty", emoji: "💇", color: "#F5E6EE" }, { name: "Others", emoji: "🛍️", color: "#ECEFF1" }
];
const PALETTE = ["#F3E6F8", "#E3EEF8", "#FCEBDD", "#E4F4EC", "#F6EFD9", "#FDE5E1", "#E1F4F7", "#F5E6EE", "#E8F0D9", "#EDE4F7"];
const FIXED_CAT = "Others"; /* catch-all: cannot be renamed or removed */
const FULFIL = ["pickup", "delivery"];
const REPORT_REASONS = ["scam", "fake", "wrong", "offensive", "other"];
const RESERVED = new Set(["admin", "api", "app", "dashboard", "signup", "login", "store", "index", "www", "mart", "trekk", "cart", "checkout", "static", "assets", "css", "js", "support", "help", "sw", "manifest", "favicon", "become-vendor", "vendor", "profile", "account", "orders", "robots", "sitemap"]);
const COLORS = ["#F26A21", "#7B4B94", "#1B6E8A", "#C2547F", "#B8892B", "#2E7D5B"];
const SQUAD_API = env.SQUAD_ENV === "sandbox" ? "https://sandbox-api-d.squadco.com" : "https://api-d.squadco.com";

/* ---------- helpers ---------- */
const now = () => new Date().toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const wrap = fn => (req, res, next) => fn(req, res).catch(next);
const naira = n => "₦" + Number(n).toLocaleString("en-NG");
const normPhone = p => {
  const raw = String(p || "").replace(/[\s-]/g, "");
  if (!/^(0|\+?234)[789][01]\d{8}$/.test(raw)) return null;
  return "234" + raw.replace(/^\+?234/, "").replace(/^0/, "");
};
const okImage = u => typeof u === "string" && u.length < 500 && u.startsWith("https://res.cloudinary.com/" + env.CLOUDINARY_CLOUD_NAME + "/");

/* ---------- categories (stored in config/categories, edited by admins) ---------- */
let catCache = { at: 0, items: null };
async function getCats(force) {
  if (!force && catCache.items && Date.now() - catCache.at < 30000) return catCache.items;
  const d = await db.doc("config/categories").get();
  const items = d.exists && Array.isArray(d.data().items) && d.data().items.length ? d.data().items : DEFAULT_CATS;
  catCache = { at: Date.now(), items }; return items;
}
const catNames = async () => (await getCats()).map(c => c.name);
const saveCats = async items => { await db.doc("config/categories").set({ items, updatedAt: now() }); catCache = { at: Date.now(), items }; };
const cleanCat = x => String(x || "").trim().replace(/\s+/g, " ");
const checkCatName = n => { if (n.length < 2 || n.length > 24 || /[<>]/.test(n)) throw fail(400, "Category names are 2 to 24 characters."); };
const cleanFulfil = a => [...new Set((Array.isArray(a) ? a : []).map(String).filter(x => FULFIL.includes(x)))];
async function moveCategory(from, to) { /* products and vendors that used a category follow it when it is renamed or removed */
  for (const col of ["products", "vendors"]) {
    for (;;) {
      const snap = await db.collection(col).where("category", "==", from).limit(400).get();
      if (snap.empty) break;
      const batch = db.batch(); snap.docs.forEach(d => batch.update(d.ref, { category: to })); await batch.commit();
      if (snap.size < 400) break;
    }
  }
}

async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) throw fail(401, "Sign in first");
    req.user = await admin.auth().verifyIdToken(h.slice(7));
    next();
  } catch (e) { if (!e.status) console.error("auth failed:", e.code || e.message); next(e.status ? e : fail(401, "Your sign-in was rejected. Sign out and sign in again.", "AUTH")); }
}
function isAdmin(req, res, next) {
  const list = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const u = req.user;
  if (u.email_verified && list.includes(String(u.email || "").toLowerCase())) return next();
  next(fail(403, "Admins only"));
}
async function myVendor(uid) {
  const [v, p] = await Promise.all([db.doc("vendors/" + uid).get(), db.doc("vendorPrivate/" + uid).get()]);
  if (!v.exists) throw fail(403, "Create your store first");
  return { v: v.data(), p: p.data() };
}
function requireApproved(v) {
  if (!v.verified || v.status !== "VERIFIED") throw fail(403, "Your store must be approved by an admin before you can upload images or publish products.", "APPROVAL_REQUIRED");
}

const app = express();
app.use((req, res, next) => { res.on("finish", () => console.log(req.method, req.originalUrl.split("?")[0], res.statusCode, "origin:", req.headers.origin || "-")); next(); }); /* shows in Render logs */
const cleanOrigin = o => String(o || "").trim().replace(/\/+$/, "").toLowerCase(); /* tolerate trailing slashes, spaces, capitals */
const origins = (env.ALLOWED_ORIGINS || "").split(",").map(cleanOrigin).filter(Boolean);
/* ALLOWED_ORIGINS entries may use * for one subdomain label, e.g. https://*.netlify.app (handy while testing) */
const originRx = origins.map(p => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+") + "$"));
const originOk = o => !o || /^http:\/\/localhost(:\d+)?$/.test(o) || originRx.some(r => r.test(cleanOrigin(o)));
app.use(cors({
  origin: (o, cb) => { const ok = originOk(o); if (!ok) console.warn("CORS blocked origin:", o, "| add it to ALLOWED_ORIGINS"); cb(null, ok); },
  maxAge: 86400
}));
app.use(express.json({ limit: "50kb" }));
app.get("/api/health", (req, res) => res.json({ ok: true, service: "trekk-mart", database: !!db }));
app.use("/api", (req, res, next) => db ? next() : res.status(503).json({ message: "The local API is not configured. Add FIREBASE_SERVICE_ACCOUNT to enable it." }));

/* ---------- vendors ---------- */
app.post("/api/vendors/register", auth, wrap(async (req, res) => {
  const b = req.body || {}, uid = req.user.uid;
  const storeName = String(b.storeName || "").trim(), slug = String(b.slug || "").trim().toLowerCase();
  const wa = normPhone(b.phone), matric = String(b.matric || "").trim(), location = String(b.location || "").trim();
  if (storeName.length < 2 || storeName.length > 40) throw fail(400, "Store name must be 2 to 40 characters.");
  if (!/^[a-z0-9-]{3,30}$/.test(slug) || RESERVED.has(slug)) throw fail(400, "Link name must be 3 to 30 letters, numbers or dashes.");
  if (!wa) throw fail(400, "Enter a valid WhatsApp number.");
  if (matric.length < 4 || matric.length > 30) throw fail(400, "Enter your matric number.");
  if (location.length < 2 || location.length > 60) throw fail(400, "Add your location or pickup area.");
  let category = String(b.category || ""), wantedCat = "";
  if (category === "__request") { wantedCat = cleanCat(b.categoryRequest); checkCatName(wantedCat); category = FIXED_CAT; }
  else if (!(await catNames()).includes(category)) throw fail(400, "Pick what you mainly sell.");
  const fulfil = cleanFulfil(b.fulfil);
  const color = COLORS[[...slug].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  await db.runTransaction(async t => {
    const vref = db.doc("vendors/" + uid), sref = db.doc("slugs/" + slug);
    const [v, s] = await Promise.all([t.get(vref), t.get(sref)]);
    if (v.exists) throw fail(409, "You already have a store.");
    if (s.exists) throw fail(409, "That link name is taken. Try another.");
    t.set(sref, { uid });
    t.set(vref, { slug, storeName, bio: String(b.bio || "").slice(0, 160), location, category, fulfil, color, wa, logo: "", status: "PENDING", verified: false, vouchCount: 0, createdAt: now() });
    t.set(db.doc("vendorPrivate/" + uid), { matric, phone: String(b.phone).trim(), bonusSlots: 0, activeCount: 0 });
  });
  if (wantedCat) await db.collection("categoryRequests").add({ vendorId: uid, storeName, name: wantedCat, status: "PENDING", createdAt: now() }).catch(() => {});
  res.json({ ok: true, slug });
}));

app.get("/api/vendors/me", auth, wrap(async (req, res) => {
  const { v, p } = await myVendor(req.user.uid);
  res.json({ store: v, slots: { used: p.activeCount || 0, limit: FREE_SLOTS + (p.bonusSlots || 0) }, packs: Object.entries(PACKS).map(([id, k]) => ({ id, ...k })) });
}));

app.patch("/api/vendors/me", auth, wrap(async (req, res) => {
  const { v } = await myVendor(req.user.uid);
  const b = req.body || {}, u = {};
  if (b.storeName != null) { const n = String(b.storeName).trim(); if (n.length < 2 || n.length > 40) throw fail(400, "Store name must be 2 to 40 characters."); u.storeName = n; }
  if (b.bio != null) u.bio = String(b.bio).slice(0, 160);
  if (b.category != null) { if (!(await catNames()).includes(String(b.category))) throw fail(400, "Pick a valid category."); u.category = String(b.category); }
  if (b.fulfil != null) u.fulfil = cleanFulfil(b.fulfil);
  if (b.location != null) { const location = String(b.location).trim(); if (location.length < 2 || location.length > 60) throw fail(400, "Add your location or pickup area."); u.location = location; }
  if (b.logo != null) { const logo = String(b.logo).trim(); if (logo) { requireApproved(v); if (!okImage(logo)) throw fail(400, "Use a photo uploaded through Trekk Mart."); } u.logo = logo; }
  if (!Object.keys(u).length) throw fail(400, "Nothing to update.");
  await db.doc("vendors/" + req.user.uid).update(u);
  res.json({ ok: true });
}));

/* Unsigned presets cannot enforce vendor approval. The browser gets a short-lived
   signature only after an admin approves the store, then uploads directly to Cloudinary. */
app.post("/api/vendors/upload-signature", auth, wrap(async (req, res) => {
  const { v } = await myVendor(req.user.uid);
  requireApproved(v);
  if (!env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET || !env.CLOUDINARY_CLOUD_NAME) throw fail(503, "Signed Cloudinary uploads are not configured on the server.", "UPLOAD_SETUP");
  const kind = String((req.body || {}).kind || "product") === "profile" ? "logos" : "products";
  const timestamp = Math.floor(Date.now() / 1000), folder = `trekk-mart/${kind}/${req.user.uid}`;
  const signature = crypto.createHash("sha1").update(`folder=${folder}&timestamp=${timestamp}` + env.CLOUDINARY_API_SECRET).digest("hex");
  res.json({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, timestamp, folder, signature });
}));

/* One vouch per signed-in customer. Vendors cannot vouch for themselves. */
app.get("/api/vendors/:id/vouch", auth, wrap(async (req, res) => {
  const snap = await db.doc(`vendorVouches/${req.params.id}_${req.user.uid}`).get();
  res.json({ vouched: snap.exists });
}));
app.post("/api/vendors/:id/vouch", auth, wrap(async (req, res) => {
  const vendorId = String(req.params.id);
  if (vendorId === req.user.uid) throw fail(400, "You cannot vouch for your own store.");
  const u = await db.doc("users/" + req.user.uid).get();
  if (!u.exists) throw fail(400, "Finish signing up before vouching.");
  const vref = db.doc("vendors/" + vendorId), rref = db.doc(`vendorVouches/${vendorId}_${req.user.uid}`);
  let fresh = false;
  const count = await db.runTransaction(async t => {
    fresh = false;
    const [vs, rs] = await Promise.all([t.get(vref), t.get(rref)]);
    if (!vs.exists || !vs.data().verified) throw fail(404, "Store not found.");
    if (rs.exists) return vs.data().vouchCount || 0;
    t.set(rref, { vendorId, customerId: req.user.uid, createdAt: now() });
    t.update(vref, { vouchCount: admin.firestore.FieldValue.increment(1) });
    fresh = true;
    return (vs.data().vouchCount || 0) + 1;
  });
  if (fresh) notifyUsers([vendorId], { title: "Someone vouched for your store 🙌", body: `You now have ${count} vouch${count > 1 ? "es" : ""}.`, link: "/dashboard.html" });
  res.json({ ok: true, vouched: true, count });
}));

/* ---------- push notifications (Firebase Cloud Messaging). Best effort: a failed alert never breaks the real action. ---------- */
const tokenId = t => crypto.createHash("sha1").update(t).digest("hex");
async function sendPush(tokens, { title, body, link }) {
  const out = { sent: 0, failed: 0 };
  const data = { title: String(title).slice(0, 80), body: String(body).slice(0, 200), link: typeof link === "string" && /^\/[\w\-./?=&%]*$/.test(link) ? link : "/" };
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const r = await admin.messaging().sendEachForMulticast({ tokens: chunk, data, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
    out.sent += r.successCount; out.failed += r.failureCount;
    const dead = [];
    r.responses.forEach((x, k) => { const c = (x.error && x.error.code) || ""; if (!x.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(c)) dead.push(chunk[k]); });
    if (dead.length) { const b = db.batch(); dead.forEach(t => b.delete(db.doc("pushTokens/" + tokenId(t)))); await b.commit(); }
  }
  return out;
}
async function notifyUsers(uids, msg) { /* never throws */
  try {
    const list = [...new Set(uids)].filter(Boolean), tokens = [];
    for (let i = 0; i < list.length; i += 10) { const s = await db.collection("pushTokens").where("uid", "in", list.slice(i, i + 10)).get(); s.docs.forEach(d => tokens.push(d.data().token)); }
    return tokens.length ? await sendPush(tokens, msg) : { sent: 0, failed: 0 };
  } catch (e) { console.error("notify failed:", e.message); return { sent: 0, failed: 0 }; }
}
async function pushAudience() {
  const [ts, vs] = await Promise.all([db.collection("pushTokens").limit(5000).get(), db.collection("vendors").select().get()]);
  const vendorIds = new Set(vs.docs.map(d => d.id)), vendorTokens = [], customerTokens = [];
  ts.docs.forEach(d => { const x = d.data(); (vendorIds.has(x.uid) ? vendorTokens : customerTokens).push(x.token); });
  return { vendorTokens, customerTokens };
}
app.post("/api/push/register", auth, wrap(async (req, res) => {
  const token = String((req.body || {}).token || "");
  if (token.length < 50 || token.length > 4096) throw fail(400, "Bad notification token.");
  const uid = req.user.uid, ref = db.doc("pushTokens/" + tokenId(token)), ex = await ref.get();
  await ref.set({ uid, token, createdAt: ex.exists ? ex.data().createdAt : now(), updatedAt: now(), ua: String(req.headers["user-agent"] || "").slice(0, 120) });
  if (!ex.exists) {
    const mine = await db.collection("pushTokens").where("uid", "==", uid).get();
    if (mine.size > 5) { const old = mine.docs.sort((a, b) => String(a.data().updatedAt).localeCompare(String(b.data().updatedAt))).slice(0, mine.size - 5); await Promise.all(old.map(d => d.ref.delete())); }
    sendPush([token], { title: "Notifications are on ✅", body: "We will tell you about orders, approvals and offers.", link: "/" }).catch(() => {});
  }
  res.json({ ok: true });
}));
app.post("/api/push/unregister", auth, wrap(async (req, res) => {
  const token = String((req.body || {}).token || ""), ref = db.doc("pushTokens/" + tokenId(token)), s = await ref.get();
  if (s.exists && s.data().uid === req.user.uid) await ref.delete();
  res.json({ ok: true });
}));
app.get("/api/admin/push-stats", auth, isAdmin, wrap(async (req, res) => { const a = await pushAudience(); res.json({ vendors: a.vendorTokens.length, customers: a.customerTokens.length }); }));
app.post("/api/admin/broadcast", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, title = String(b.title || "").trim(), body = String(b.body || "").trim(), audience = String(b.audience || "");
  if (!["vendors", "customers", "everyone"].includes(audience)) throw fail(400, "Pick who receives it.");
  if (title.length < 2 || title.length > 60) throw fail(400, "Title must be 2 to 60 characters.");
  if (body.length < 2 || body.length > 160) throw fail(400, "Message must be 2 to 160 characters.");
  const link = /^\/[\w\-./?=&%]*$/.test(String(b.link || "")) ? String(b.link) : "/";
  const a = await pushAudience(), tokens = audience === "vendors" ? a.vendorTokens : audience === "customers" ? a.customerTokens : a.vendorTokens.concat(a.customerTokens);
  if (!tokens.length) throw fail(400, "Nobody in that group has turned on notifications yet.");
  const r = await sendPush(tokens, { title, body, link });
  await db.collection("broadcasts").add({ by: req.user.email || req.user.uid, audience, title, body, link, devices: tokens.length, sent: r.sent, failed: r.failed, createdAt: now() });
  res.json({ ok: true, devices: tokens.length, sent: r.sent, failed: r.failed });
}));

/* ---------- products (approval and limits enforced here, never in the browser) ---------- */
app.post("/api/products", auth, wrap(async (req, res) => {
  const uid = req.user.uid, b = req.body || {};
  const { v } = await myVendor(uid);
  requireApproved(v);
  const title = String(b.title || "").trim(), price = Math.round(Number(b.price));
  const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map(s => String(s).trim().slice(0, 20)).filter(Boolean).slice(0, 10);
  const images = Array.isArray(b.images) ? b.images.slice(0, 3) : [];
  if (title.length < 2 || title.length > 80) throw fail(400, "Title must be 2 to 80 characters.");
  if (!(price >= 1 && price <= 10000000)) throw fail(400, "Enter a valid price.");
  const description = String(b.description || "").trim().slice(0, 600);
  if (description.length < 10) throw fail(400, "Describe the product so buyers know what they are getting (at least 10 characters).");
  if (!(await catNames()).includes(b.category)) throw fail(400, "Pick a category.");
  if (!images.length || !images.every(okImage)) throw fail(400, "Add at least one photo.");
  const pref = db.collection("products").doc(), vp = db.doc("vendorPrivate/" + uid);
  await db.runTransaction(async t => {
    const p = (await t.get(vp)).data(), used = p.activeCount || 0;
    if (used >= FREE_SLOTS + (p.bonusSlots || 0)) throw fail(403, "Slot limit reached. Buy more slots to add products.", "LIMIT");
    t.set(pref, { vendorId: uid, vendorSlug: v.slug, title, price, description, category: b.category, sizes: sizes.length ? sizes : ["One size"], images, location: v.location || "", status: "ACTIVE", createdAt: now() });
    t.update(vp, { activeCount: used + 1 });
  });
  res.json({ id: pref.id });
}));

app.patch("/api/products/:id/description", auth, wrap(async (req, res) => {
  const description = String((req.body || {}).description || "").trim().slice(0, 600);
  if (description.length < 10) throw fail(400, "Describe the product in at least 10 characters.");
  const pref = db.doc("products/" + req.params.id), ps = await pref.get();
  if (!ps.exists || ps.data().vendorId !== req.user.uid) throw fail(404, "Product not found.");
  await pref.update({ description }); res.json({ ok: true });
}));

/* Edit a product: title, price, description, category, sizes and photos. Status and slots are untouched. */
app.patch("/api/products/:id", auth, wrap(async (req, res) => {
  const uid = req.user.uid, b = req.body || {};
  const { v } = await myVendor(uid);
  requireApproved(v);
  const pref = db.doc("products/" + req.params.id), ps = await pref.get();
  if (!ps.exists || ps.data().vendorId !== uid || ps.data().status === "REMOVED") throw fail(404, "Product not found.");
  const title = String(b.title || "").trim(), price = Math.round(Number(b.price));
  const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map(s => String(s).trim().slice(0, 20)).filter(Boolean).slice(0, 10);
  const images = Array.isArray(b.images) ? b.images.slice(0, 3) : [];
  const description = String(b.description || "").trim().slice(0, 600);
  if (title.length < 2 || title.length > 80) throw fail(400, "Title must be 2 to 80 characters.");
  if (!(price >= 1 && price <= 10000000)) throw fail(400, "Enter a valid price.");
  if (description.length < 10) throw fail(400, "Describe the product so buyers know what they are getting (at least 10 characters).");
  if (!(await catNames()).includes(b.category)) throw fail(400, "Pick a category.");
  if (!images.length || !images.every(okImage)) throw fail(400, "Keep or add at least one photo.");
  await pref.update({ title, price, description, category: b.category, sizes: sizes.length ? sizes : ["One size"], images, updatedAt: now() });
  res.json({ ok: true });
}));

app.post("/api/products/:id/status", auth, wrap(async (req, res) => {
  const to = String((req.body || {}).status), uid = req.user.uid;
  if (!["ACTIVE", "SOLD_OUT", "REMOVED"].includes(to)) throw fail(400, "Bad status.");
  const pref = db.doc("products/" + req.params.id), vp = db.doc("vendorPrivate/" + uid), vref = db.doc("vendors/" + uid);
  await db.runTransaction(async t => {
    const [ps, vs, vps] = await Promise.all([t.get(pref), t.get(vref), t.get(vp)]);
    if (!ps.exists || ps.data().vendorId !== uid) throw fail(404, "Product not found.");
    const from = ps.data().status;
    if (from === to) return;
    if (from === "REMOVED") throw fail(400, "Removed products cannot be restored.");
    const priv = vps.data(); let active = priv.activeCount || 0;
    if (to === "ACTIVE") {
      requireApproved(vs.data());
      if (active >= FREE_SLOTS + (priv.bonusSlots || 0)) throw fail(403, "Slot limit reached. Buy more slots to relist.", "LIMIT");
      active++;
    } else if (from === "ACTIVE") active--;
    t.update(pref, { status: to });
    t.update(vp, { activeCount: active });
  });
  res.json({ ok: true });
}));

/* ---------- checkout: price from the database, log the order, return WhatsApp links ---------- */
app.post("/api/orders", auth, wrap(async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 40) : [];
  if (!items.length) throw fail(400, "Your cart is empty.");
  const u = (await db.doc("users/" + req.user.uid).get()).data();
  if (!u || !u.name || !u.phone) throw fail(400, "Finish signing up before checkout.");
  const ids = [...new Set(items.map(i => String(i.id)))];
  if (!ids.every(id => /^[A-Za-z0-9]{20}$/.test(id))) throw fail(400, "Bad item in cart.");
  const snaps = await db.getAll(...ids.map(id => db.doc("products/" + id)));
  const prods = Object.fromEntries(snaps.filter(s => s.exists).map(s => [s.id, s.data()]));
  const by = {};
  for (const i of items) {
    const p = prods[String(i.id)], q = Math.floor(Number(i.q)), size = String(i.size || "");
    if (!p || p.status !== "ACTIVE") throw fail(400, "An item in your cart is no longer available.");
    if (!(q >= 1 && q <= 20)) throw fail(400, "Bad quantity.");
    if (!p.sizes.includes(size)) throw fail(400, "Pick a valid size.");
    (by[p.vendorId] ||= []).push({ id: String(i.id), title: p.title, price: p.price, size, q });
  }
  const vsnaps = await db.getAll(...Object.keys(by).map(id => db.doc("vendors/" + id)));
  const batch = db.batch(), orders = [];
  for (const vs of vsnaps) {
    const v = vs.data(), lines = by[vs.id], total = lines.reduce((a, l) => a + l.price * l.q, 0);
    const oref = db.collection("orders").doc(), code = oref.id.slice(0, 6).toUpperCase();
    batch.set(oref, { buyerId: req.user.uid, buyerName: u.name, buyerPhone: u.phone, vendorId: vs.id, vendorSlug: v.slug, items: lines, total, status: "SENT_TO_WHATSAPP", createdAt: now() });
    const what = lines.map(l => `${l.title} (Size: ${l.size}, ${naira(l.price)}) x${l.q}`).join("; ");
    const text = `Hi ${v.storeName}! I want to buy ${what} listed on Trekk Mart. Total: ${naira(total)}. Order #${code}. Buyer Name: ${u.name}, Phone: ${u.phone}.`;
    orders.push({ orderId: oref.id, code, vendorSlug: v.slug, vendorName: v.storeName, total, wa: "https://wa.me/" + v.wa + "?text=" + encodeURIComponent(text) });
  }
  await batch.commit();
  orders.forEach((o, i) => { const n = by[vsnaps[i].id].reduce((a, l) => a + l.q, 0); notifyUsers([vsnaps[i].id], { title: "New order request 🛒", body: `${u.name} wants ${n} item${n > 1 ? "s" : ""} (${naira(o.total)}). Check your WhatsApp.`, link: "/dashboard.html" }); });
  res.json({ orders });
}));

/* ---------- slot payments (Squad) ----------
   The browser never sends an amount. It sends a pack id, the server decides the price,
   and slots are only credited after the server confirms the payment with Squad. */
app.get("/api/slots/packs", (req, res) => res.json(Object.entries(PACKS).map(([id, p]) => ({ id, ...p }))));

app.post("/api/slots/init", auth, wrap(async (req, res) => {
  const uid = req.user.uid, { v } = await myVendor(uid), packId = String((req.body || {}).packId), pack = PACKS[packId];
  if (!pack) throw fail(400, "Pick a slot pack.");
  if (!req.user.email) throw fail(400, "Your account needs an email to pay.");
  const ref = "TM_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
  await db.doc("slotPayments/" + ref).set({ vendorId: uid, storeName: v.storeName, packId, slots: pack.slots, amount: pack.amount, amountKobo: pack.amount * 100, status: "PENDING", createdAt: now() });
  res.json({ ref, amountKobo: pack.amount * 100, email: req.user.email });
}));

async function settle(ref) {
  const pref = db.doc("slotPayments/" + ref), snap = await pref.get();
  if (!snap.exists) throw fail(404, "Unknown payment reference.");
  const p = snap.data();
  if (p.status === "SUCCESS") return { status: "SUCCESS" };
  const r = await fetch(SQUAD_API + "/transaction/verify/" + encodeURIComponent(ref), { headers: { Authorization: "Bearer " + env.SQUAD_SECRET_KEY } });
  const j = await r.json().catch(() => ({})), d = (j && j.data) || {};
  if (String(d.transaction_status || "").toLowerCase() !== "success") return { status: "PENDING" };
  if (Number(d.transaction_amount) !== p.amountKobo) {
    await pref.update({ status: "FAILED", reason: "AMOUNT_MISMATCH", got: Number(d.transaction_amount) || 0 });
    throw fail(400, "Payment amount did not match. Contact support with ref " + ref);
  }
  await db.runTransaction(async t => { // idempotent: webhook and browser can both land here
    const ps = await t.get(pref);
    if (ps.data().status === "SUCCESS") return;
    const vp = db.doc("vendorPrivate/" + p.vendorId), vs = await t.get(vp);
    t.update(vp, { bonusSlots: (vs.data().bonusSlots || 0) + p.slots });
    t.update(pref, { status: "SUCCESS", paidAt: now() });
  });
  return { status: "SUCCESS" };
}

app.post("/api/slots/verify", auth, wrap(async (req, res) => {
  const ref = String((req.body || {}).ref || "");
  if (!/^TM_\d+_[a-f0-9]{8}$/.test(ref)) throw fail(400, "Bad reference.");
  const s = await db.doc("slotPayments/" + ref).get();
  if (!s.exists || s.data().vendorId !== req.user.uid) throw fail(404, "Payment not found.");
  res.json(await settle(ref));
}));

/* Backup path if the browser closes before verify. Safe without signature checks because
   settle() always re-confirms with Squad's own API using the secret key. */
app.post("/api/squad/webhook", wrap(async (req, res) => {
  const b = req.body || {}, ref = b.TransactionRef || (b.Body && b.Body.transaction_ref) || b.transaction_ref;
  if (typeof ref === "string" && ref.startsWith("TM_")) { try { await settle(ref); } catch (e) { console.error("webhook", ref, e.message); } }
  res.sendStatus(200);
}));

app.post("/api/slots/request", auth, wrap(async (req, res) => {
  const uid = req.user.uid, { v } = await myVendor(uid), url = String((req.body || {}).videoUrl || "").trim();
  if (!/^https?:\/\/\S{6,300}$/.test(url)) throw fail(400, "Paste the full video link.");
  const open = await db.collection("slotRequests").where("vendorId", "==", uid).where("status", "==", "PENDING").limit(1).get();
  if (!open.empty) throw fail(409, "You already have a request under review.");
  await db.collection("slotRequests").add({ vendorId: uid, storeName: v.storeName, videoUrl: url, status: "PENDING", createdAt: now() });
  res.json({ ok: true });
}));

/* ---------- admin ---------- */
const count = async q => (await q.count().get()).data().count;
app.get("/api/admin/stats", auth, isAdmin, wrap(async (req, res) => {
  const [pendingCategories, pendingReports] = await Promise.all([count(db.collection("categoryRequests").where("status", "==", "PENDING")), count(db.collection("reports").where("status", "==", "OPEN"))]);
  const [buyers, vendors, activeProducts, pendingVendors, pendingRequests, orders, paid] = await Promise.all([
    count(db.collection("users")), count(db.collection("vendors")), count(db.collection("products").where("status", "==", "ACTIVE")),
    count(db.collection("vendors").where("status", "==", "PENDING")), count(db.collection("slotRequests").where("status", "==", "PENDING")),
    count(db.collection("orders")), db.collection("slotPayments").where("status", "==", "SUCCESS").get()]);
  res.json({ buyers, vendors, activeProducts, orders, dispatches: 0, revenue: paid.docs.reduce((a, d) => a + d.data().amount, 0), pendingVendors, pendingRequests, pendingCategories, pendingReports });
}));

app.get("/api/admin/vendors", auth, isAdmin, wrap(async (req, res) => {
  const q = req.query.status === "pending" ? db.collection("vendors").where("status", "==", "PENDING") : db.collection("vendors").limit(200);
  const vs = await q.get();
  const ps = vs.empty ? [] : await db.getAll(...vs.docs.map(d => db.doc("vendorPrivate/" + d.id)));
  res.json(vs.docs.map((d, i) => { const x = d.data(), p = ps[i].data() || {}; return { id: d.id, slug: x.slug, storeName: x.storeName, status: x.status, location: x.location || x.hostel || "", category: x.category || "", logo: x.logo || "", vouchCount: x.vouchCount || 0, matric: p.matric, phone: p.phone, activeCount: p.activeCount || 0 }; }));
}));

app.post("/api/admin/vendors/:id/review", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, ref = db.doc("vendors/" + req.params.id);
  if (!(await ref.get()).exists) throw fail(404, "Vendor not found.");
  if (b.decision === "VERIFY") { await ref.update({ status: "VERIFIED", verified: true, reviewReason: "" }); await notifyUsers([req.params.id], { title: "Your store is approved 🎉", body: "You can now add your logo and list your products.", link: "/dashboard.html" }); }
  else if (b.decision === "REJECT" && String(b.reason || "").trim()) { await ref.update({ status: "REJECTED", verified: false, reviewReason: String(b.reason).trim().slice(0, 200) }); await notifyUsers([req.params.id], { title: "Your store needs attention", body: String(b.reason).trim().slice(0, 120), link: "/dashboard.html" }); }
  else throw fail(400, "Bad decision.");
  res.json({ ok: true });
}));

app.get("/api/admin/requests", auth, isAdmin, wrap(async (req, res) => {
  const s = await db.collection("slotRequests").where("status", "==", "PENDING").get();
  res.json(s.docs.map(d => ({ id: d.id, ...d.data() })));
}));

app.post("/api/admin/requests/:id/decision", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, rref = db.doc("slotRequests/" + req.params.id);
  await db.runTransaction(async t => {
    const rs = await t.get(rref);
    if (!rs.exists || rs.data().status !== "PENDING") throw fail(404, "Request not found or already handled.");
    if (b.decision === "APPROVE") {
      const vp = db.doc("vendorPrivate/" + rs.data().vendorId), vs = await t.get(vp);
      t.update(vp, { bonusSlots: (vs.data().bonusSlots || 0) + UGC_BONUS });
      t.update(rref, { status: "APPROVED", decidedAt: now() });
    } else if (b.decision === "REJECT") t.update(rref, { status: "REJECTED", reason: String(b.reason || "").slice(0, 200), decidedAt: now() });
    else throw fail(400, "Bad decision.");
  });
  res.json({ ok: true });
}));

app.get("/api/admin/payments", auth, isAdmin, wrap(async (req, res) => {
  const s = await db.collection("slotPayments").orderBy("createdAt", "desc").limit(100).get();
  res.json(s.docs.map(d => { const x = d.data(); return { reference: d.id, storeName: x.storeName, amount: x.amount, status: x.status, slotsAdded: x.status === "SUCCESS" ? x.slots : 0, createdAt: x.createdAt }; }));
}));

/* ---------- vendor asks for a category that does not exist yet ---------- */
app.post("/api/category-requests", auth, wrap(async (req, res) => {
  const { v } = await myVendor(req.user.uid);
  const name = cleanCat((req.body || {}).name); checkCatName(name);
  if ((await catNames()).some(n => n.toLowerCase() === name.toLowerCase())) throw fail(400, "That category already exists. Pick it from the list.");
  const open = await db.collection("categoryRequests").where("vendorId", "==", req.user.uid).where("status", "==", "PENDING").limit(1).get();
  if (!open.empty) throw fail(409, "You already have a category request waiting for review.");
  await db.collection("categoryRequests").add({ vendorId: req.user.uid, storeName: v.storeName, name, status: "PENDING", createdAt: now() });
  res.json({ ok: true });
}));

/* ---------- reports from customers ---------- */
app.post("/api/reports", auth, wrap(async (req, res) => {
  const b = req.body || {}, type = b.type === "product" ? "product" : "vendor", reason = String(b.reason || "");
  if (!REPORT_REASONS.includes(reason)) throw fail(400, "Pick a reason.");
  const targetId = String(b.targetId || "");
  if (!/^[A-Za-z0-9]{20,40}$/.test(targetId)) throw fail(400, "Bad report.");
  let vendorId = targetId;
  if (type === "product") { const ps = await db.doc("products/" + targetId).get(); if (!ps.exists) throw fail(404, "Product not found."); vendorId = ps.data().vendorId; }
  else if (!(await db.doc("vendors/" + targetId).get()).exists) throw fail(404, "Store not found.");
  if (vendorId === req.user.uid) throw fail(400, "You cannot report your own store.");
  /* one report per person per target, so nobody can spam the queue */
  await db.doc("reports/" + req.user.uid + "_" + targetId).set({ type, targetId, vendorId, reason, note: String(b.note || "").trim().slice(0, 300), reporterId: req.user.uid, status: "OPEN", createdAt: now() });
  res.json({ ok: true });
}));

/* ---------- admin: categories, category requests, reports ---------- */
app.get("/api/admin/categories", auth, isAdmin, wrap(async (req, res) => {
  const [items, rs] = await Promise.all([getCats(true), db.collection("categoryRequests").where("status", "==", "PENDING").get()]);
  res.json({ items, requests: rs.docs.map(d => ({ id: d.id, ...d.data() })) });
}));
app.post("/api/admin/categories", auth, isAdmin, wrap(async (req, res) => {
  const name = cleanCat((req.body || {}).name), emoji = String((req.body || {}).emoji || "").trim().slice(0, 8) || "🛍️"; checkCatName(name);
  const items = await getCats(true);
  if (items.some(c => c.name.toLowerCase() === name.toLowerCase())) throw fail(409, "That category already exists.");
  const others = items.findIndex(c => c.name === FIXED_CAT), next = items.slice();
  next.splice(others < 0 ? next.length : others, 0, { name, emoji, color: PALETTE[items.length % PALETTE.length] }); /* keep Others last */
  await saveCats(next); res.json({ ok: true });
}));
app.post("/api/admin/categories/edit", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, from = String(b.from || ""), name = cleanCat(b.name), emoji = String(b.emoji || "").trim().slice(0, 8); checkCatName(name);
  const items = await getCats(true), i = items.findIndex(c => c.name === from);
  if (i < 0) throw fail(404, "Category not found.");
  if (from === FIXED_CAT && name !== FIXED_CAT) throw fail(400, "Others is the catch-all and cannot be renamed.");
  if (name.toLowerCase() !== from.toLowerCase() && items.some(c => c.name.toLowerCase() === name.toLowerCase())) throw fail(409, "That name is already used.");
  const next = items.slice(); next[i] = { ...items[i], name, emoji: emoji || items[i].emoji };
  await saveCats(next);
  if (name !== from) await moveCategory(from, name);
  res.json({ ok: true });
}));
app.post("/api/admin/categories/remove", auth, isAdmin, wrap(async (req, res) => {
  const name = String((req.body || {}).name || "");
  if (name === FIXED_CAT) throw fail(400, "Others cannot be removed.");
  const items = await getCats(true);
  if (!items.some(c => c.name === name)) throw fail(404, "Category not found.");
  await saveCats(items.filter(c => c.name !== name));
  await moveCategory(name, FIXED_CAT); /* its products and vendors move to Others */
  res.json({ ok: true });
}));
app.post("/api/admin/category-requests/:id/decision", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, rref = db.doc("categoryRequests/" + req.params.id), rs = await rref.get();
  if (!rs.exists || rs.data().status !== "PENDING") throw fail(404, "Request not found or already handled.");
  if (b.decision === "REJECT") { await rref.update({ status: "REJECTED", reason: String(b.reason || "").slice(0, 200), decidedAt: now() }); return res.json({ ok: true }); }
  if (b.decision !== "APPROVE") throw fail(400, "Bad decision.");
  const name = cleanCat(b.name || rs.data().name); checkCatName(name);
  const items = await getCats(true); let final = (items.find(c => c.name.toLowerCase() === name.toLowerCase()) || {}).name;
  if (!final) {
    const emoji = String(b.emoji || "").trim().slice(0, 8) || "🛍️", others = items.findIndex(c => c.name === FIXED_CAT), next = items.slice();
    next.splice(others < 0 ? next.length : others, 0, { name, emoji, color: PALETTE[items.length % PALETTE.length] });
    await saveCats(next); final = name;
  }
  await db.doc("vendors/" + rs.data().vendorId).update({ category: final }).catch(() => {});
  await rref.update({ status: "APPROVED", approvedAs: final, decidedAt: now() });
  res.json({ ok: true });
}));
app.get("/api/admin/reports", auth, isAdmin, wrap(async (req, res) => {
  const snap = await db.collection("reports").where("status", "==", "OPEN").limit(300).get(), by = {};
  snap.docs.forEach(d => { const r = d.data(), g = by[r.targetId] ||= { targetId: r.targetId, type: r.type, vendorId: r.vendorId, count: 0, reasons: {}, notes: [], last: "" }; g.count++; g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1; if (r.note && g.notes.length < 3) g.notes.push(r.note); if (r.createdAt > g.last) g.last = r.createdAt; });
  const groups = Object.values(by).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 60);
  const vids = [...new Set(groups.map(g => g.vendorId))], vsn = vids.length ? await db.getAll(...vids.map(id => db.doc("vendors/" + id))) : [];
  const vmap = Object.fromEntries(vsn.filter(x => x.exists).map(x => [x.id, x.data()]));
  const pg = groups.filter(g => g.type === "product"), psn = pg.length ? await db.getAll(...pg.map(g => db.doc("products/" + g.targetId))) : [];
  const pmap = Object.fromEntries(psn.filter(x => x.exists).map(x => [x.id, x.data()]));
  res.json(groups.map(g => { const v = vmap[g.vendorId] || {}, p = pmap[g.targetId] || {}; return { ...g, storeName: v.storeName || "Unknown store", slug: v.slug || "", vendorStatus: v.status || "", title: p.title || "", price: p.price || 0, image: (p.images || [])[0] || "", productStatus: p.status || "" }; }));
}));
app.post("/api/admin/reports/resolve", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, targetId = String(b.targetId || ""), action = String(b.action || "");
  if (!/^[A-Za-z0-9]{20,40}$/.test(targetId)) throw fail(400, "Bad target.");
  if (action === "TAKEDOWN") {
    const pref = db.doc("products/" + targetId);
    await db.runTransaction(async t => {
      const ps = await t.get(pref); if (!ps.exists) return;
      const vp = db.doc("vendorPrivate/" + ps.data().vendorId), vps = await t.get(vp);
      if (ps.data().status === "ACTIVE" && vps.exists) t.update(vp, { activeCount: Math.max(0, (vps.data().activeCount || 0) - 1) });
      t.update(pref, { status: "REMOVED" });
    });
  } else if (action === "SUSPEND") {
    const vid = String(b.vendorId || targetId);
    if (!/^[A-Za-z0-9]{20,40}$/.test(vid)) throw fail(400, "Bad vendor.");
    await db.doc("vendors/" + vid).update({ status: "REJECTED", verified: false, reviewReason: "Suspended after customer reports. Contact Trekk support." });
  } else if (action !== "DISMISS") throw fail(400, "Bad action.");
  const open = await db.collection("reports").where("targetId", "==", targetId).where("status", "==", "OPEN").get();
  const batch = db.batch(); open.docs.forEach(d => batch.update(d.ref, { status: action === "DISMISS" ? "DISMISSED" : "ACTIONED", action, decidedAt: now() })); await batch.commit();
  res.json({ ok: true });
}));

/* ---------- storefront + social-sharing previews ---------- */
const path = require("path"), fs = require("fs");
const publicFile = name => path.join(__dirname, name);
const staticOpts = { index: false, maxAge: env.NODE_ENV === "production" ? "1h" : 0 };
[["/css", "css"], ["/js", "js"], ["/assets", "assets"]].forEach(([route, dir]) => app.use(route, express.static(publicFile(dir), staticOpts)));
["manifest.webmanifest", "sw.js"].forEach(name => app.get("/" + name, (req, res) => res.sendFile(publicFile(name))));
app.get("/", (req, res) => fs.existsSync(publicFile("index.html")) ? res.sendFile(publicFile("index.html")) : res.json({ ok: true, service: "trekk-mart-api" }));
["index", "store", "dashboard", "signup", "admin"].forEach(name => {
  app.get("/" + name + ".html", (req, res) => res.sendFile(publicFile(name + ".html")));
});
["dashboard", "signup", "admin"].forEach(name => {
  app.get("/" + name, (req, res) => res.sendFile(publicFile(name + ".html")));
});
app.get("/favicon.ico", (req, res) => res.sendFile(publicFile("assets/icons/icon-192.png")));
const metaEsc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
app.get("/:slug", wrap(async (req, res) => {
  if (!fs.existsSync(publicFile("store.html"))) return res.status(404).json({ status: "error", message: "Not found." });
  let html = fs.readFileSync(publicFile("store.html"), "utf8");
  const slug = String(req.params.slug || "").toLowerCase();
  if (db && /^[a-z0-9-]{3,30}$/.test(slug)) {
    const snap = await db.collection("vendors").where("slug", "==", slug).limit(1).get();
    if (!snap.empty) {
      const v = snap.docs[0].data(), title = `${v.storeName} | Trekk Mart`;
      const description = v.bio || `Shop ${v.storeName} on Trekk Mart.${v.location ? " Location: " + v.location + "." : ""}`;
      const image = v.logo || `${req.protocol}://${req.get("host")}/assets/icons/icon-512.png`;
      const url = `${req.protocol}://${req.get("host")}/${slug}`;
      const meta = `<meta property="og:type" content="website"><meta property="og:title" content="${metaEsc(title)}"><meta property="og:description" content="${metaEsc(description)}"><meta property="og:image" content="${metaEsc(image)}"><meta property="og:url" content="${metaEsc(url)}"><meta name="twitter:card" content="summary_large_image">`;
      html = html.replace(/\s*<meta (?:property="og:[^"]+"|name="twitter:card")[^>]*>/g, "");
      html = html.replace(/<title>.*?<\/title>/, `<title>${metaEsc(title)}</title>`).replace("</head>", meta + "</head>");
    }
  }
  res.type("html").send(html);
}));

/* ---------- errors ---------- */
app.use((e, req, res, next) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ status: "error", message: e.status ? e.message : "Something went wrong. Try again.", code: e.code });
});
if (require.main === module) app.listen(env.PORT || 3000, () => console.log("Trekk Mart backend up"));
module.exports = app;
