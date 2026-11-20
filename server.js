// Zaiqa — Pakistani food-business directory
// Node.js 24+, native node:http + node:sqlite ONLY. No external dependencies.
// Run: node server.js  (port 3011, or PORT env)
// Real security: verification and login codes go to the user's own Gmail by
// SMTP (SMTP_USER + SMTP_PASS env vars — a Gmail app password). The code is
// NEVER returned in an API response once email is configured. Only when no
// SMTP is configured AND NODE_ENV is not 'production' (local development)
// is the code returned in the response (DEV_CODE_IN_RESPONSE) so the app
// can still be tested on a PC with no mailbox wired up.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3011);
const ROOT = __dirname;
// Deploy-only writable-location fallback (no behaviour change on a normal PC):
// on a local run ROOT is writable, so the original paths below are used exactly
// as before. Only when ROOT cannot be written (e.g. SnapDeploy's /app, which
// denied creating /app/uploads and /app/zaiqa.sqlite) do the database and
// uploads move to a writable temp directory. No API, schema or seed changes.
const os = require('node:os');
function writableBase() {
  try { fs.accessSync(ROOT, fs.constants.W_OK); return ROOT; }
  catch { return path.join(os.tmpdir(), 'zaiqa'); }
}
const DATA_ROOT = writableBase();
const DB_PATH = path.join(DATA_ROOT, 'zaiqa.sqlite');
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEV = process.env.NODE_ENV !== 'production';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (DATA_ROOT !== ROOT) console.log('Zaiqa data directory (read-only app dir fallback):', DATA_ROOT);

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=ON;");
const schemaPath = path.join(ROOT, 'sql', 'schema.sql');
if (fs.existsSync(schemaPath)) db.exec(fs.readFileSync(schemaPath, 'utf8'));
// Column migrations for databases created before these fields existed.
function migrate() {
  const adds = [
    ['vendors', 'halal_declared', 'INTEGER NOT NULL DEFAULT 0'],
    ['vendors', 'halal_verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['vendors', 'payment_methods', "TEXT NOT NULL DEFAULT 'Cash on Delivery'"],
    ['menu_items', 'updated_at', 'TEXT'],
    ['reviews', 'photo_url', 'TEXT'],
  ];
  for (const [table, col, def] of adds) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* column already exists */ }
  }
  try { db.exec("UPDATE menu_items SET updated_at = created_at WHERE updated_at IS NULL"); } catch { /* backfill is best-effort */ }
  // Backfill for vendors seeded before opening hours existed: only vendors
  // with NO hours rows are touched, so this runs once per vendor and never
  // overwrites a manager's own choices afterwards.
  try {
    for (const v of db.prepare('SELECT * FROM vendors').all()) {
      const hasHours = db.prepare('SELECT COUNT(*) c FROM vendor_hours WHERE vendor_id=?').get(v.id).c;
      if (hasHours) continue;
      for (let d = 0; d < 7; d++) db.prepare('INSERT INTO vendor_hours (vendor_id, day_of_week, open_time, close_time, closed) VALUES (?,?,?,?,0)').run(v.id, d, '11:00', '23:00');
      db.prepare('UPDATE vendors SET halal_declared=1, halal_verified=?, payment_methods=? WHERE id=?')
        .run(['Chapli Kabab House', 'Burns Road Nihari'].includes(v.name) ? 1 : 0, v.delivery_enabled ? 'Cash on Delivery, JazzCash, Easypaisa' : 'Cash on Delivery', v.id);
    }
  } catch { /* backfill is best-effort */ }
  // Fresh-start model (2026-11-19): listings may be UNCLAIMED, so
  // vendors.manager_id must be nullable. Rebuild the table once if it is
  // still NOT NULL; deleting a manager then unclaims their vendor
  // (ON DELETE SET NULL) instead of wiping the listing (CASCADE).
  try {
    const col = db.prepare('PRAGMA table_info(vendors)').all().find((c) => c.name === 'manager_id');
    if (col && col.notnull === 1) {
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec('BEGIN');
      db.exec(`CREATE TABLE vendors_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        city TEXT NOT NULL,
        area TEXT,
        address TEXT,
        description TEXT,
        delivery_phone TEXT,
        google_maps_url TEXT,
        primary_image_url TEXT,
        banner_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','pending_update','rejected','suspended')),
        open INTEGER NOT NULL DEFAULT 1,
        delivery_enabled INTEGER NOT NULL DEFAULT 0,
        delivery_fee_pkr INTEGER DEFAULT 0,
        min_order_pkr INTEGER DEFAULT 0,
        delivery_time TEXT,
        subscription_plan TEXT,
        subscription_expires_at TEXT,
        approved_at TEXT,
        rejection_reason TEXT,
        suspension_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        halal_declared INTEGER NOT NULL DEFAULT 0,
        halal_verified INTEGER NOT NULL DEFAULT 0,
        payment_methods TEXT NOT NULL DEFAULT 'Cash on Delivery'
      )`);
      db.exec(`INSERT INTO vendors_new (id,manager_id,name,slug,category,city,area,address,description,delivery_phone,google_maps_url,primary_image_url,banner_url,status,open,delivery_enabled,delivery_fee_pkr,min_order_pkr,delivery_time,subscription_plan,subscription_expires_at,approved_at,rejection_reason,suspension_reason,created_at,updated_at,halal_declared,halal_verified,payment_methods)
        SELECT id,manager_id,name,slug,category,city,area,address,description,delivery_phone,google_maps_url,primary_image_url,banner_url,status,open,delivery_enabled,delivery_fee_pkr,min_order_pkr,delivery_time,subscription_plan,subscription_expires_at,approved_at,rejection_reason,suspension_reason,created_at,updated_at,halal_declared,halal_verified,payment_methods FROM vendors`);
      db.exec('DROP TABLE vendors');
      db.exec('ALTER TABLE vendors_new RENAME TO vendors');
      db.exec('CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_vendors_slug ON vendors(slug)');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON');
      console.log('Migrated vendors.manager_id to nullable (unclaimed listings).');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    try { db.exec('PRAGMA foreign_keys=ON'); } catch {}
    console.log('vendors.manager_id migration skipped: ' + e.message);
  }
  // Seed the admin-published plans once (Basic 30d/1500, Premium 90d/4500,
  // Featured 90d/9000). Later changes go through the admin panel, never code.
  try {
    if (db.prepare('SELECT COUNT(*) c FROM plans').get().c === 0) {
      const ins = db.prepare('INSERT INTO plans (name, days, price_pkr, published) VALUES (?,?,?,1)');
      ins.run('Basic', 30, 1500);
      ins.run('Premium', 90, 4500);
      ins.run('Featured', 90, 9000);
    }
  } catch { /* plans table missing on very old DBs is fixed by schema.sql at boot */ }
  // Payments used to CHECK plan IN ('Basic','Premium','Featured') — that
  // blocks admin-created plan names. Rebuild the table once without it
  // (method/status CHECKs stay; data is preserved).
  try {
    const paySql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'").get();
    if (paySql && paySql.sql && paySql.sql.includes("plan IN (")) {
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec('BEGIN');
      db.exec(`CREATE TABLE payments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
        plan TEXT NOT NULL,
        amount_pkr INTEGER NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('Bank Transfer','Easypaisa','JazzCash','Sadapay','Nayapay','Manual Reference')),
        reference_text TEXT,
        proof_path TEXT,
        proof_mimetype TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        admin_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      )`);
      db.exec('INSERT INTO payments_new SELECT id, manager_id, vendor_id, plan, amount_pkr, method, reference_text, proof_path, proof_mimetype, status, admin_note, created_at, decided_at FROM payments');
      db.exec('DROP TABLE payments');
      db.exec('ALTER TABLE payments_new RENAME TO payments');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON');
      console.log('Rebuilt payments table (plan names are now free-form).');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    try { db.exec('PRAGMA foreign_keys=ON'); } catch {}
    console.log('payments plan CHECK migration skipped: ' + e.message);
  }
}
migrate();

const DEFAULT_PLANS = {
  Basic: { days: 30, price: 1500 },
  Premium: { days: 90, price: 4500 },
  Featured: { days: 90, price: 9000 },
};
// Plans live in the DB (admin-published). These helpers read them; the
// DEFAULT_PLANS constant above is only the seed written by migrate().
function getPlans(publishedOnly = true) {
  const rows = db.prepare(publishedOnly
    ? 'SELECT name, days, price_pkr FROM plans WHERE published=1 ORDER BY price_pkr ASC'
    : 'SELECT id, name, days, price_pkr, published, created_at FROM plans ORDER BY price_pkr ASC').all();
  const out = {};
  for (const r of rows) out[r.name] = { days: r.days, price: r.price_pkr };
  return out;
}
function getPlan(name) { // published plan only (what a manager may buy)
  const r = db.prepare('SELECT name, days, price_pkr FROM plans WHERE name=? AND published=1').get(name);
  return r ? { days: r.days, price: r.price_pkr } : null;
}
function getPlanAny(name) { // any plan row (admin approvals must still work for unpublished plans)
  const r = db.prepare('SELECT name, days, price_pkr FROM plans WHERE name=?').get(name);
  return r ? { days: r.days, price: r.price_pkr } : null;
}
const PAYMENT_METHODS = ['Bank Transfer', 'Easypaisa', 'JazzCash', 'Sadapay', 'Nayapay', 'Manual Reference'];
const CATEGORIES = ['Desi', 'BBQ', 'Karahi', 'Fast Food', 'Sweets', 'Chinese', 'Bakery', 'Beverages'];
const SENSITIVE_FIELDS = ['name', 'google_maps_url', 'delivery_phone', 'primary_image_url', 'banner_url', 'slug'];
const NON_SENSITIVE_VENDOR_FIELDS = ['category', 'city', 'area', 'address', 'description', 'open', 'delivery_enabled', 'delivery_fee_pkr', 'min_order_pkr', 'delivery_time', 'halal_declared', 'payment_methods'];
const VENDOR_PAYMENT_METHODS = ['Cash on Delivery', 'JazzCash', 'Easypaisa', 'Bank Transfer'];
const REPORT_TYPES = ['wrong_phone', 'closed', 'moved', 'wrong_price', 'wrong_info', 'other'];

// ---------- helpers ----------
function nowISO() { return new Date().toISOString(); }
function addDaysISO(days) { return new Date(Date.now() + days * 86400000).toISOString(); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function randToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function randCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
}
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vendor';
}
function isEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim()); }
function isPhonePK(s) {
  if (typeof s !== 'string') return false;
  const t = s.replace(/[\s-]/g, '');
  return /^(03\d{9}|\+92\d{10}|92\d{10})$/.test(t);
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (opts.httpOnly) c += '; HttpOnly';
  if (opts.maxAge) c += `; Max-Age=${opts.maxAge}`;
  if (opts.expires) c += `; Expires=${opts.expires}`;
  const prev = res.getHeader('Set-Cookie');
  if (prev) res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, c] : [prev, c]);
  else res.setHeader('Set-Cookie', c);
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 6 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
  });
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, verified: !!u.verified, status: u.status };
}
function audit(actor, action, targetType, targetId, reason, details) {
  try {
    db.prepare('INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, reason, details) VALUES (?,?,?,?,?,?,?)')
      .run(actor ? actor.id : null, actor ? actor.role : null, action, targetType || null, targetId || null, reason || null, details ? JSON.stringify(details) : null);
  } catch { /* audit must never break the request */ }
}
// Rate limiting (in-memory, per IP + key): contact 4/30min, newsletter 5/30min
const rateBuckets = new Map();
function rateLimit(ip, key, max, windowMs) {
  const now = Date.now();
  const k = ip + ':' + key;
  const arr = (rateBuckets.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now); rateBuckets.set(k, arr); return true;
}
const loginOtpStore = new Map(); // login_token -> {userId, codeHash, expiresAt}

// ---------- real email OTP (Brevo HTTPS API first, SMTP fallback) ----------
// Brevo is the live mail road: Railway blocks outbound SMTP (ETIMEDOUT on
// 465 + 587, verified 2026-11-20), so the Gmail app-password SMTP path can
// never send from Railway. Brevo's API is plain HTTPS (port 443), free
// 300 emails/day, no card, no domain — the sender is one verified Gmail
// address (a confirmation link clicked in that inbox). Env vars are set in
// the host env (Railway Variables on live). The API key is never written to
// any file, log, chat or API response; it only travels in the HTTPS header.
// SMTP stays as a fallback for hosts where it works. BREVO_API_URL is
// overridable so the test suite can point it at a local stub.
const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim();
const BREVO_SENDER_EMAIL = (process.env.BREVO_SENDER_EMAIL || 'mhkh3200@gmail.com').trim();
const BREVO_SENDER_NAME = (process.env.BREVO_SENDER_NAME || 'Zaiqa').trim();
const BREVO_API_URL = (process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email').trim();
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = (process.env.SMTP_FROM || SMTP_USER || 'Zaiqa <noreply@zaiqa.app>').trim();
const SITE_URL = (process.env.PUBLIC_URL || 'https://zaiqa-production.up.railway.app').replace(/\/$/, '');
function brevoConfigured() { return BREVO_API_KEY !== ''; }
function smtpConfigured() { return SMTP_USER !== '' && SMTP_PASS !== ''; }
function emailConfigured() { return brevoConfigured() || smtpConfigured(); }

// Send one email through the Brevo transactional API (HTTPS, zero deps —
// the global fetch on Node 24). 201 = accepted. Any other status is an API
// rejection (401 bad key, 403 sender not verified, 429 daily cap) — the
// reason carries only the status + Brevo's error code, never the key.
async function sendViaBrevo(to, subject, text) {
  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject: String(subject).replace(/[\r\n]/g, ' '),
        textContent: String(text),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 201 || res.status === 200) return { sent: true, reason: 'sent' };
    let code = '';
    try { const j = await res.json(); if (j && j.code) code = ':' + String(j.code); } catch {}
    return { sent: false, reason: 'brevo_' + res.status + code };
  } catch (err) {
    return { sent: false, reason: 'brevo_error:' + (err && err.code ? err.code : 'unknown') };
  }
}

// Minimal SMTP client over implicit TLS (port 465): EHLO, AUTH LOGIN,
// MAIL FROM, RCPT TO, DATA, QUIT. No dependencies, no raw secrets logged.
function sendMail(to, subject, text) {
  return new Promise((resolve) => {
    if (!emailConfigured()) return resolve({ sent: false, reason: 'not_configured' });
    let done = false, active = null;
    const finish = (ok, reason) => {
      if (done) return; done = true; clearTimeout(timer);
      if (active) { try { active.destroy(); } catch {} }
      resolve({ sent: ok, reason });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), 30000);
    // The EHLO -> QUIT conversation on an already-connected socket.
    // `label` prefixes socket failures so the log shows which transport
    // failed and how (e.g. socket_error:ECONNREFUSED). Error codes and
    // SMTP reply codes never contain credentials.
    const converse = (sock, label) => new Promise((res) => {
      active = sock;
      let buf = '', stage = 0, settled = false;
      const stop = (ok, reason) => { if (settled) return; settled = true; res({ sent: ok, reason }); };
      const send = (line) => { try { sock.write(line + '\r\n'); } catch { stop(false, 'write_failed'); } };
      const body = String(text).split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
      const data = [
        'From: ' + SMTP_FROM,
        'To: ' + to,
        'Subject: ' + String(subject).replace(/[\r\n]/g, ' '),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
      ].join('\r\n');
      sock.on('error', (err) => stop(false, label + ':' + (err && err.code ? err.code : 'unknown')));
      sock.on('close', () => stop(false, label + ':closed'));
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (!buf.includes('\n')) return;
        const lines = buf.split('\r\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!/^\d{3}[ -]/.test(line)) continue; // wait for a full reply line
          const code = line.slice(0, 3);
          if (stage === 0 && code === '220') { stage = 1; send('EHLO zaiqa'); }
          else if (stage === 1 && code === '250') { stage = 2; send('AUTH LOGIN'); }
          else if (stage === 2 && code === '334') { stage = 3; send(Buffer.from(SMTP_USER, 'utf8').toString('base64')); }
          else if (stage === 3 && code === '334') { stage = 4; send(Buffer.from(SMTP_PASS, 'utf8').toString('base64')); }
          else if (stage === 4 && code === '235') { stage = 5; send('MAIL FROM:<' + SMTP_USER + '>'); }
          else if (stage === 5 && code === '250') { stage = 6; send('RCPT TO:<' + to + '>'); }
          else if (stage === 6 && code === '250') { stage = 7; send('DATA'); }
          else if (stage === 7 && code === '354') { stage = 8; send(data + '\r\n.'); }
          else if (stage === 8 && code === '250') { stage = 9; send('QUIT'); stop(true, 'sent'); }
          else if (code[0] === '4' || code[0] === '5') { stop(false, 'smtp_' + code); }
        }
      });
    });
    const tryImplicitTLS = async () => {
      const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
      sock.setTimeout(15000);
      sock.on('timeout', () => { try { sock.destroy(); } catch {} });
      return converse(sock, 'socket_error');
    };
    // Plain TCP on 587, EHLO, STARTTLS, then upgrade the same socket.
    const tryStartTLS = async () => {
      const plain = net.connect({ host: SMTP_HOST, port: 587 });
      plain.setTimeout(15000);
      plain.on('timeout', () => { try { plain.destroy(); } catch {} });
      let sawEhlo = false, sawStart = false;
      const pre = await new Promise((res) => {
        let b = '', ok = false;
        const stop = (v) => { if (ok) return; ok = true; res(v); };
        plain.on('error', (err) => stop({ err: 'starttls_error:' + (err && err.code ? err.code : 'unknown') }));
        plain.on('close', () => stop({ err: 'starttls_error:closed' }));
        plain.on('data', (chunk) => {
          b += chunk.toString('utf8');
          if (!b.includes('\n')) return;
          const lines = b.split('\r\n'); b = lines.pop();
          for (const line of lines) {
            if (!/^\d{3}[ -]/.test(line)) continue;
            const code = line.slice(0, 3);
            if (code === '220' && !sawEhlo) { sawEhlo = true; try { plain.write('EHLO zaiqa\r\n'); } catch { stop({ err: 'starttls_error:write_failed' }); } }
            else if (code === '250' && sawEhlo && !sawStart) { sawStart = true; try { plain.write('STARTTLS\r\n'); } catch { stop({ err: 'starttls_error:write_failed' }); } }
            else if (code === '220' && sawStart) { stop({ upgraded: true }); }
            else if (code[0] === '4' || code[0] === '5') { stop({ err: 'smtp_' + code }); }
          }
        });
      });
      if (!pre.upgraded) { try { plain.destroy(); } catch {} return { sent: false, reason: pre.err || 'starttls_error:closed' }; }
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');
      const upgraded = tls.connect({ socket: plain, servername: SMTP_HOST });
      upgraded.setTimeout(15000);
      upgraded.on('timeout', () => { try { upgraded.destroy(); } catch {} });
      return converse(upgraded, 'socket_error');
    };
    (async () => {
      // Brevo first when configured: HTTPS reaches Railway's egress where
      // SMTP cannot (465/587 time out there). A Brevo failure falls through
      // to SMTP when it is configured; the log line keeps both reasons.
      let brevoReason = null;
      if (brevoConfigured()) {
        const rb = await sendViaBrevo(to, subject, text);
        if (rb.sent) return finish(true, 'sent');
        brevoReason = rb.reason;
        if (!smtpConfigured()) return finish(false, brevoReason);
      }
      const r1 = await tryImplicitTLS();
      if (r1.sent) return finish(true, 'sent');
      // Fall back to 587 only when the 465 socket itself failed (port
      // unreachable/blocked) — not when the server answered or the
      // credentials were rejected. Only the default 465 port gets a fallback.
      const prefix = brevoReason ? brevoReason + ' + smtp ' : '';
      if (SMTP_PORT === 465 && r1.reason && r1.reason.startsWith('socket_error')) {
        const r2 = await tryStartTLS();
        if (r2.sent) return finish(true, 'sent');
        return finish(false, prefix + r1.reason + ' + 587:' + r2.reason);
      }
      return finish(false, prefix + r1.reason);
    })();
  });
}

// Code-issuance limits: at most 5 codes per email per hour, at most 5 wrong
// guesses per code before the code is invalidated and a new one is needed.
const codeSends = new Map(); // email -> [timestamps]
const codeAttempts = new Map(); // identifier -> count
function codeSendAllowed(email) {
  const now = Date.now();
  const list = (codeSends.get(email) || []).filter((t) => now - t < 3600000);
  if (list.length >= 5) return false;
  list.push(now); codeSends.set(email, list);
  return true;
}
function noteWrongAttempt(identifier) {
  const n = (codeAttempts.get(identifier) || 0) + 1;
  codeAttempts.set(identifier, n);
  return n;
}
function clearAttempts(identifier) { codeAttempts.delete(identifier); }

// Send a 6-digit code to the user's Gmail. Returns the channel used.
//  - 'email': the code was sent by email, Brevo API or SMTP (code is NOT in
//             the API response)
//  - 'dev':   no email configured + local development — code IS in the response
//  - 'none':  no email + production — the code cannot be delivered anywhere
//  - 'failed': email configured but the send failed
//  - 'limited': too many codes to this email in the last hour
async function deliverCode(user, code, purpose) {
  const email = user.email;
  if (!email) {
    // Phone-only account: there is no email to send to. Local dev shows the
    // code on screen; production refuses phone registration before this
    // point, so a phone user can never reach here on live.
    if (DEV) return { channel: 'dev', dev_code: code };
    return { channel: 'none' };
  }
  if (!codeSendAllowed(email)) return { channel: 'limited' };
  const subjects = {
    verify: 'Your Zaiqa verification code',
    login: 'Your Zaiqa login code',
    'manager-setup': 'Your Zaiqa manager account is ready',
  };
  const bodies = {
    verify: `Your Zaiqa verification code is: ${code}\n\nIt expires in 15 minutes. Enter it on the Zaiqa verify form to activate your account.\n\nIf you did not ask for this code, ignore this email.\n\n— Zaiqa (Taste Pakistan)`,
    login: `Your Zaiqa login code is: ${code}\n\nIt expires in 15 minutes. Enter it on the Zaiqa login page to reach your dashboard.\n\nIf you did not ask for this code, ignore this email — your password was not changed.\n\n— Zaiqa (Taste Pakistan)`,
    'manager-setup': `You have been added as a manager on Zaiqa.\n\nYour setup code is: ${code}\n\nIt expires in 15 minutes. Open ${SITE_URL}/#/register and use the "Manager setup" form with this code and your new password to activate your manager account.\n\nIf you did not expect this, ignore this email.\n\n— Zaiqa (Taste Pakistan)`,
  };
  if (emailConfigured()) {
    const r = await sendMail(email, subjects[purpose] || subjects.verify, bodies[purpose] || bodies.verify);
    if (r.sent) { console.log(`OTP email sent (${purpose}) to ${email}`); return { channel: 'email' }; }
    console.log(`OTP email FAILED (${purpose}) to ${email}: ${r.reason}`);
    if (DEV) return { channel: 'dev', dev_code: code }; // local dev fallback only
    return { channel: 'failed' };
  }
  if (DEV) return { channel: 'dev', dev_code: code };
  return { channel: 'none' };
}
// Map a deliverCode channel to the HTTP error a caller must send, or null
// when the caller may proceed (channel 'email' or 'dev').
function channelError(channel) {
  if (channel === 'none') return { status: 503, error: 'Email is not configured on this server. The Portal Admin must connect email (Brevo API key) before accounts can be verified.' };
  if (channel === 'failed') return { status: 503, error: 'The verification email could not be sent. Please try again in a few minutes.' };
  if (channel === 'limited') return { status: 429, error: 'Too many codes sent to this email in the last hour. Please try again later.' };
  return null;
}
// ---------- review safety scan ----------
const PROFANITY = ['bakwas', 'harami', 'chutiya', 'bhenchod', 'madarchod', 'lanat', 'haramzada', 'kutta', 'idiot', 'stupid', 'shit', 'fuck', 'bitch', 'bastard', 'damn'];
const THREATS = ['kill', 'mar dunga', 'maar dunga', 'jaan se mar', 'bomb', 'i will kill', 'threat', 'attack you', 'goli'];
function scanReview(comment) {
  const text = String(comment || '');
  const low = text.toLowerCase();
  let score = 0; const reasons = [];
  for (const w of PROFANITY) if (low.includes(w)) { score += 25; reasons.push('profanity/abuse: ' + w); break; }
  for (const w of THREATS) if (low.includes(w)) { score += 30; reasons.push('threat: ' + w); break; }
  if (/https?:\/\/|www\./i.test(text)) { score += 25; reasons.push('spam: link'); }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) { score += 25; reasons.push('exposed contact: email'); }
  if (/(03\d{9}|\+92\d{10})/.test(text.replace(/[\s-]/g, ''))) { score += 25; reasons.push('exposed contact: phone'); }
  if (/(.)\1{4,}/.test(text)) { score += 15; reasons.push('repeated characters'); }
  if (text.trim().length < 15) { score += 20; reasons.push('short low-context'); }
  if (/(free|discount|promo|click|whatsapp|order now).{0,20}(free|discount|promo|click|whatsapp)/i.test(text)) { score += 20; reasons.push('spam pattern'); }
  return { score, reasons };
}
// ---------- uploads (base64 JSON) ----------
const ALLOWED_UPLOADS = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'application/pdf': Buffer.from('%PDF'),
};
function saveUpload({ filename, mimetype, base64 }) {
  if (!filename || !mimetype || !base64) return { error: 'filename, mimetype and base64 are required' };
  if (!ALLOWED_UPLOADS[mimetype]) return { error: 'Only PNG, JPEG or PDF uploads are allowed' };
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return { error: 'Upload must be non-empty and under 5 MB' };
  const magic = ALLOWED_UPLOADS[mimetype];
  if (!buf.subarray(0, magic.length).equals(magic)) return { error: 'File signature does not match its declared type' };
  const ext = mimetype === 'application/pdf' ? 'pdf' : mimetype === 'image/png' ? 'png' : 'jpg';
  const name = randToken(12) + '.' + ext;
  const full = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(full, buf);
  return { path: 'uploads/' + name, mimetype };
}
// ---------- vendor visibility / ratings ----------
function isPublicVendor(v) {
  if (!v) return false;
  if (v.status !== 'approved' && v.status !== 'pending_update') return false;
  if (!v.open) return false;
  if (!v.approved_at) return false;
  if (!v.subscription_expires_at) return false;
  if (new Date(v.subscription_expires_at).getTime() <= Date.now()) return false;
  return true;
}
function vendorRatings(vendorId) {
  const rows = db.prepare("SELECT food, hygiene, value_rating, overall, delivery FROM reviews WHERE vendor_id=? AND status='active'").all(vendorId);
  if (!rows.length) return { count: 0, food: null, hygiene: null, value: null, overall: null, delivery: null };
  const avg = (k) => {
    const vals = rows.map((r) => r[k]).filter((x) => x != null);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  };
  return { count: rows.length, food: avg('food'), hygiene: avg('hygiene'), value: avg('value_rating'), overall: avg('overall'), delivery: avg('delivery') };
}
// ---------- opening hours (Pakistan time, UTC+5, no DST) ----------
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function pktNow() {
  const d = new Date(Date.now() + 5 * 3600 * 1000);
  return { day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function fmtClock(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function parseClock(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function vendorHours(vendorId) {
  return db.prepare('SELECT day_of_week, open_time, close_time, closed FROM vendor_hours WHERE vendor_id=? ORDER BY day_of_week').all(vendorId)
    .map((r) => ({ day: r.day_of_week, open: r.open_time, close: r.close_time, closed: !!r.closed }));
}
function openNowInfo(v) {
  const hours = vendorHours(v.id);
  const base = { hours, open_now: !!v.open, closes_at: null, opens_at: null };
  if (!v.open) return base;
  if (!hours.length) return base;
  const { day, mins } = pktNow();
  const fmtDay = (d, time) => (d === day ? 'Today ' : DAY_NAMES[d].slice(0, 3) + ' ') + time;
  const today = hours.find((h) => h.day === day);
  if (today && !today.closed) {
    const o = parseClock(today.open), c = parseClock(today.close);
    if (o != null && c != null) {
      if (mins >= o && mins < c) return { ...base, open_now: true, closes_at: fmtClock(c) };
      if (mins < o) return { ...base, open_now: false, opens_at: fmtDay(day, fmtClock(o)) };
    }
  }
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    const row = hours.find((h) => h.day === d);
    if (row && !row.closed) {
      const o = parseClock(row.open);
      if (o != null) return { ...base, open_now: false, opens_at: fmtDay(d, fmtClock(o)) };
    }
  }
  return { ...base, open_now: false };
}
function vendorPublic(v) {
  const info = openNowInfo(v);
  return {
    id: v.id, name: v.name, slug: v.slug, category: v.category, city: v.city, area: v.area,
    address: v.address, description: v.description, delivery_phone: v.delivery_phone,
    google_maps_url: v.google_maps_url, primary_image_url: v.primary_image_url, banner_url: v.banner_url,
    status: v.status, open: !!v.open, delivery_enabled: !!v.delivery_enabled,
    delivery_fee_pkr: v.delivery_fee_pkr, min_order_pkr: v.min_order_pkr, delivery_time: v.delivery_time,
    subscription_plan: v.subscription_plan, approved_at: v.approved_at,
    subscription_expires_at: v.subscription_expires_at, created_at: v.created_at,
    halal_declared: !!v.halal_declared, halal_verified: !!v.halal_verified,
    payment_methods: v.payment_methods || 'Cash on Delivery',
    open_now: info.open_now, closes_at: info.closes_at, opens_at: info.opens_at, hours: info.hours,
    ratings: vendorRatings(v.id),
  };
}
function vendorDetail(v) {
  const out = vendorPublic(v);
  out.menu = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY category, name').all(v.id)
    .map((m) => ({ ...m, available: !!m.available }));
  out.gallery = db.prepare("SELECT * FROM gallery_items WHERE vendor_id=? AND status='approved' ORDER BY id").all(v.id);
  out.reviews = db.prepare("SELECT r.*, u.name AS customer_name FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.vendor_id=? AND r.status IN ('active','flagged') ORDER BY r.created_at DESC").all(v.id)
    .map((r) => ({ id: r.id, customer_name: r.customer_name, food: r.food, hygiene: r.hygiene, value: r.value_rating, overall: r.overall, delivery: r.delivery, comment: r.comment, status: r.status, admin_reply: r.admin_reply, photo_url: r.photo_url || null, created_at: r.created_at }));
  out.certificates = db.prepare("SELECT cert_type, created_at FROM certificates WHERE vendor_id=? AND status='approved' ORDER BY id").all(v.id);
  const mu = db.prepare('SELECT MAX(updated_at) m FROM menu_items WHERE vendor_id=?').get(v.id);
  out.menu_last_updated = mu ? mu.m : null;
  return out;
}
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.zq_session;
  if (!token) return { user: null, session: null, cookies };
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return { user: null, session: null, cookies };
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if (!user || user.status === 'suspended') return { user: null, session: null, cookies };
  return { user, session: row, cookies };
}
function requireAuth(req, res, roles) {
  const { user, session } = getSessionUser(req);
  if (!user) { sendJSON(res, 401, { error: 'Login required' }); return null; }
  if (roles && !roles.includes(user.role)) { sendJSON(res, 403, { error: 'Forbidden for role ' + user.role }); return null; }
  return { user, session };
}
function requireCsrf(req, res, session) {
  const cookies = parseCookies(req);
  const header = req.headers['x-csrf-token'];
  const cookieVal = cookies.zq_csrf;
  const ok = header && cookieVal && header === cookieVal;
  const okSession = session && header && header === session.csrf_token;
  if (!ok && !okSession) { sendJSON(res, 403, { error: 'Invalid CSRF token. Fetch GET /api/csrf first and send X-CSRF-Token.' }); return false; }
  return true;
}
const CSRF_EXEMPT = new Set(['/api/auth/login', '/api/auth/register-customer', '/api/auth/register-manager', '/api/auth/verify', '/api/auth/request-code', '/api/auth/login-verify', '/api/auth/login-resend', '/api/auth/manager-setup']);
function isMutation(method, pathname) { return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method); }

// ---------- seed ----------
function createUserSeed({ name, email, phone, contact_type, role, password, verified }) {
  const salt = randToken(16);
  const r = db.prepare('INSERT INTO users (name,email,phone,contact_type,role,password_hash,salt,verified) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, email || null, phone || null, contact_type || null, role, hashPassword(password, salt), salt, verified ? 1 : 0);
  return Number(r.lastInsertRowid);
}
// ---------- owner bootstrap + vendor seed (fresh-start model) ----------
// No demo accounts are created anywhere in code any more. The old seeded
// passwords used to sit in this public repo, so anyone could log in as the
// admin. The Portal Admin now comes ONLY from ADMIN_EMAIL + ADMIN_PASSWORD
// env vars; managers and customers register on the site itself. Listings
// are seeded UNCLAIMED (manager_id NULL) and the admin assigns each one
// to a registered manager from the Admin panel.
function ensureOwnerFromEnv() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (password.length < 8) { console.log('ADMIN_PASSWORD too short (8+ chars) — owner not created'); return; }
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (existing) return; // never escalate or overwrite an existing account
  const salt = randToken(16);
  db.prepare("INSERT INTO users (name,email,contact_type,role,password_hash,salt,verified) VALUES (?,?,?,?,?,?,1)")
    .run('M. Hashir', email, 'email', 'owner', hashPassword(password, salt), salt);
  console.log('Portal Admin created from ADMIN_EMAIL');
}
function seedVendors() {
  if (db.prepare('SELECT COUNT(*) c FROM vendors').get().c > 0) return;
  console.log('Seeding Zaiqa vendors (unclaimed)...');
  const far = addDaysISO(120); // subscription comfortably in the future
  const insV = db.prepare(`INSERT INTO vendors (manager_id,name,slug,category,city,area,address,description,delivery_phone,google_maps_url,primary_image_url,banner_url,status,open,delivery_enabled,delivery_fee_pkr,min_order_pkr,delivery_time,subscription_plan,subscription_expires_at,approved_at)
    VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addMenu = db.prepare('INSERT INTO menu_items (vendor_id,name,description,price_pkr,category,available) VALUES (?,?,?,?,?,1)');
  const addGallery = db.prepare("INSERT INTO gallery_items (vendor_id,url,caption,status) VALUES (?,?,?,'approved')");

  // 1. Approved — Peshawar BBQ/Desi
  let id = Number(insV.run('Chapli Kabab House', 'chapli-kabab-house', 'BBQ', 'Peshawar', 'University Road', 'Main University Road, Peshawar', 'Famous Peshawari chapli kababs cooked on open flame, served with naan, salad and green chutney. Family seating available.', '03331234567', 'https://maps.google.com/?q=Chapli+Kabab+House+Peshawar', 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143?w=800', 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1200', 'approved', 1, 1, 150, 500, '30-45 min', 'Premium', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Chapli Kabab (2 pcs)', 'Beef chapli kabab with tomato, onion and green chilli', 450, 'BBQ');
  addMenu.run(id, 'Chapli Kabab Platter', '4 kababs, naan, salad, raita and chutney', 850, 'BBQ');
  addMenu.run(id, 'Chicken Tikka', 'Charcoal-grilled chicken tikka, served hot', 380, 'BBQ');
  addMenu.run(id, 'Naan', 'Fresh tandoori naan', 40, 'Bread');
  addGallery.run(id, 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143?w=800', 'Chapli kabab platter');

  // 2. Approved — Karachi Burns Road Desi
  id = Number(insV.run('Burns Road Nihari', 'burns-road-nihari', 'Desi', 'Karachi', 'Burns Road', 'Burns Road, Saddar, Karachi', 'Slow-cooked beef nihari since decades, served with ginger, lemon and fresh naan. A Burns Road classic.', '03211234567', 'https://maps.google.com/?q=Burns+Road+Nihari+Karachi', 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=1200', 'approved', 1, 1, 200, 600, '40-60 min', 'Featured', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Beef Nihari (Single)', 'Slow-cooked nihari with gravy, ginger and lemon', 650, 'Desi');
  addMenu.run(id, 'Beef Nihari (Double)', 'Double portion for a full appetite', 1100, 'Desi');
  addMenu.run(id, 'Chicken Nihari', 'Lighter chicken nihari, same rich gravy', 550, 'Desi');
  addMenu.run(id, 'Naan', 'Tandoori naan', 50, 'Bread');

  // 3. Approved — Lahore Karahi
  id = Number(insV.run('Lahore Karahi House', 'lahore-karahi-house', 'Karahi', 'Lahore', 'Food Street, Fort Road', 'Food Street, Fort Road, Lahore', 'Desi chicken and mutton karahi cooked in desi ghee, with fresh tomatoes and green chillies.', '03001239876', 'https://maps.google.com/?q=Lahore+Karahi+House+Food+Street', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800', 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=1200', 'approved', 1, 1, 180, 800, '35-50 min', 'Premium', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Chicken Karahi (Half)', 'Half chicken karahi in desi ghee', 950, 'Karahi');
  addMenu.run(id, 'Chicken Karahi (Full)', 'Full chicken karahi, serves 3-4', 1800, 'Karahi');
  addMenu.run(id, 'Mutton Karahi (Half)', 'Mutton karahi, slow cooked', 2200, 'Karahi');
  addMenu.run(id, 'Garlic Naan', 'Garlic butter naan', 80, 'Bread');
  addMenu.run(id, 'Chicken Biryani (Full)', 'Fragrant chicken biryani with raita and salad', 350, 'Desi');

  // 4. Pending update — still public (approved before, update requested)
  id = Number(insV.run('Islamabad Grill & Burgers', 'islamabad-grill-burgers', 'Fast Food', 'Islamabad', 'F-7 Markaz', 'Jinnah Super Market, F-7 Markaz, Islamabad', 'Grilled burgers, loaded fries and shakes. Dine-in and delivery across Islamabad.', '03151234567', 'https://maps.google.com/?q=Islamabad+Grill+Burgers+F7', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800', 'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=1200', 'pending_update', 1, 1, 150, 400, '25-40 min', 'Basic', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Zinger Burger', 'Crispy chicken zinger with fries', 550, 'Burgers');
  addMenu.run(id, 'Beef Smash Burger', 'Double smashed beef patty, cheese and sauce', 750, 'Burgers');
  addMenu.run(id, 'Loaded Fries', 'Fries with chicken, cheese sauce and jalapenos', 450, 'Sides');

  // 5. Approved — Sweets
  id = Number(insV.run('Sweet Palace Lahore', 'sweet-palace-lahore', 'Sweets', 'Lahore', 'Gulberg III', 'Main Boulevard, Gulberg III, Lahore', 'Fresh barfi, gulab jamun, jalebi and traditional mithai made daily. Gift boxes available.', '03007654321', 'https://maps.google.com/?q=Sweet+Palace+Lahore+Gulberg', 'https://images.unsplash.com/photo-1551024506-0bccd828d307?w=800', 'https://images.unsplash.com/photo-1589308078059-be1415eab4c3?w=1200', 'approved', 1, 0, 0, 300, '', 'Basic', far, nowISO()).lastInsertRowid);
  addMenu.run(id, 'Mix Barfi (1 kg)', 'Assorted fresh barfi', 1200, 'Mithai');
  addMenu.run(id, 'Gulab Jamun (1 kg)', 'Soft gulab jamun in light syrup', 900, 'Mithai');
  addMenu.run(id, 'Fresh Jalebi (500 g)', 'Crispy jalebi made to order', 450, 'Mithai');

  // 6 & 7. Pending — NOT public
  id = Number(insV.run('Karachi Fast Bites', 'karachi-fast-bites', 'Fast Food', 'Karachi', 'Gulshan-e-Iqbal', 'Main University Road, Gulshan-e-Iqbal, Karachi', 'Burgers, broast and rolls for quick evening meals.', '03337654321', 'https://maps.google.com/?q=Karachi+Fast+Bites', '', '', 'pending', 1, 1, 120, 300, '20-35 min', null, null, null).lastInsertRowid);
  addMenu.run(id, 'Chicken Broast (2 pcs)', 'Crispy broast with fries', 480, 'Fast Food');
  id = Number(insV.run('Islamabad Chinese Corner', 'islamabad-chinese-corner', 'Chinese', 'Islamabad', 'G-9 Markaz', 'G-9 Markaz, Islamabad', 'Chinese rice, noodles and Manchurian with local taste.', '03119876543', 'https://maps.google.com/?q=Islamabad+Chinese+Corner', '', '', 'pending', 1, 1, 150, 500, '30-45 min', null, null, null).lastInsertRowid);
  addMenu.run(id, 'Chicken Chowmein', 'Chicken noodles with vegetables', 600, 'Chinese');
  // Opening hours (11 AM - 11 PM daily) + halal/payment defaults.
  const addHours = db.prepare('INSERT INTO vendor_hours (vendor_id, day_of_week, open_time, close_time, closed) VALUES (?,?,?,?,0)');
  for (const v of db.prepare('SELECT * FROM vendors').all()) {
    for (let d = 0; d < 7; d++) addHours.run(v.id, d, '11:00', '23:00');
    db.prepare('UPDATE vendors SET halal_declared=1, halal_verified=?, payment_methods=? WHERE id=?')
      .run(['Chapli Kabab House', 'Burns Road Nihari'].includes(v.name) ? 1 : 0, v.delivery_enabled ? 'Cash on Delivery, JazzCash, Easypaisa' : 'Cash on Delivery', v.id);
  }
  console.log('Vendor seed complete.');
}
ensureOwnerFromEnv();
seedVendors();

// ---------- HTTP ----------
function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    if (pathname.startsWith('/uploads/')) {
      const rel = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
      const uf = path.join(DATA_ROOT, rel);
      if (uf.startsWith(DATA_ROOT) && fs.existsSync(uf)) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        fs.createReadStream(uf).pipe(res); return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  const ext = path.extname(full);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method;
    const ip = req.socket.remoteAddress || 'unknown';
    if (pathname.startsWith('/api/')) {
      // CSRF gate for mutations (except auth bootstrap)
      if (isMutation(method, pathname) && !CSRF_EXEMPT.has(pathname)) {
        const { session } = getSessionUser(req);
        if (!requireCsrf(req, res, session)) return;
      }
      const body = isMutation(method, pathname) ? await readBody(req) : {};
      // ---- meta ----
      if (method === 'GET' && pathname === '/api/health') return sendJSON(res, 200, { ok: true, service: 'zaiqa', time: nowISO() });
      if (method === 'GET' && pathname === '/api/csrf') {
        const token = randToken(16);
        setCookie(res, 'zq_csrf', token);
        return sendJSON(res, 200, { csrfToken: token });
      }
      if (method === 'GET' && pathname === '/api/plans') return sendJSON(res, 200, { plans: getPlans(true), methods: PAYMENT_METHODS, categories: CATEGORIES });
      if (method === 'GET' && pathname === '/api/categories') return sendJSON(res, 200, { categories: CATEGORIES });
      // ---- auth ----
      if (method === 'POST' && pathname === '/api/auth/register-customer') {
        const { name, email, phone, password } = body;
        if (!name || !password || password.length < 8) return sendJSON(res, 400, { error: 'Name and a password of 8+ characters are required' });
        const hasEmail = !!email, hasPhone = !!phone;
        if (hasEmail === hasPhone) return sendJSON(res, 400, { error: 'Register with exactly ONE contact channel: email OR phone, never both' });
        if (hasEmail && !isEmail(email)) return sendJSON(res, 400, { error: 'Valid email required' });
        if (hasPhone && !isPhonePK(phone)) return sendJSON(res, 400, { error: 'Valid Pakistani phone required (03XXXXXXXXX)' });
        // Phone-only registration has no delivery channel: there is no SMS
        // provider, so a phone code could never arrive. In production a
        // phone registration is refused honestly instead of creating an
        // account that can never be verified. (Local dev still shows the
        // code on screen, so the flow stays testable on a PC.)
        if (hasPhone && !DEV) return sendJSON(res, 400, { error: 'Phone registration needs SMS verification, which is not connected yet — please register with your Gmail instead.' });
        const code = randCode();
        const salt = randToken(16);
        const userStub = { email: hasEmail ? email.trim() : null };
        const sent = await deliverCode(userStub, code, 'verify');
        const err = channelError(sent.channel);
        if (err) return sendJSON(res, err.status, { error: err.error });
        try {
          const r = db.prepare('INSERT INTO users (name,email,phone,contact_type,role,password_hash,salt,verification_code_hash,verification_expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(name.trim(), hasEmail ? email.trim() : null, hasPhone ? phone.trim() : null, hasEmail ? 'email' : 'phone', 'customer', hashPassword(password, salt), salt, sha256(code), new Date(Date.now() + 15 * 60000).toISOString());
          const out = { ok: true, userId: Number(r.lastInsertRowid), channel: sent.channel, message: sent.channel === 'email' ? 'Account created. We emailed your verification code — enter it below to activate it.' : 'Account created. Enter the verification code to activate it.' };
          if (sent.dev_code) out.dev_code = sent.dev_code; // DEVELOPMENT ONLY
          return sendJSON(res, 201, out);
        } catch (e) { return sendJSON(res, 409, { error: 'That email or phone is already registered' }); }
      }
      if (method === 'POST' && pathname === '/api/auth/register-manager') {
        // Public manager signup is closed: manager accounts are created by
        // the Portal Admin (POST /api/admin/managers) and activated with a
        // setup code emailed to the manager. This keeps fake manager
        // accounts — and fake listings — off the directory.
        return sendJSON(res, 410, { error: 'Manager accounts are created by the Portal Admin. Ask the admin to create your manager account — a setup code will be emailed to you.' });
      }
      // Manager setup: an admin-created manager activates their account
      // with the code emailed to them and sets their own password.
      if (method === 'POST' && pathname === '/api/auth/manager-setup') {
        const { email, code, password } = body;
        if (!isEmail(email) || !code || !password || password.length < 8) return sendJSON(res, 400, { error: 'Email, setup code and an 8+ character password are required' });
        const u = db.prepare("SELECT * FROM users WHERE email=? AND role='manager'").get(email.trim().toLowerCase());
        if (!u) return sendJSON(res, 404, { error: 'No manager account for that email — ask the Portal Admin to create one first' });
        if (u.verified) return sendJSON(res, 400, { error: 'This manager account is already set up. Log in with your password.' });
        if (!u.verification_code_hash || u.verification_code_hash !== sha256(String(code)) || new Date(u.verification_expires_at).getTime() < Date.now()) {
          const n = noteWrongAttempt(email.trim().toLowerCase());
          if (n >= 5) { db.prepare('UPDATE users SET verification_code_hash=NULL WHERE id=?').run(u.id); return sendJSON(res, 400, { error: 'Too many wrong attempts. Ask the Portal Admin to send a new setup code.' }); }
          return sendJSON(res, 400, { error: 'Invalid or expired setup code' });
        }
        clearAttempts(email.trim().toLowerCase());
        const salt = randToken(16);
        db.prepare('UPDATE users SET password_hash=?, salt=?, verified=1, verification_code_hash=NULL WHERE id=?').run(hashPassword(password, salt), salt, u.id);
        audit(u, 'manager_setup', 'user', u.id, null, null);
        return sendJSON(res, 200, { ok: true, message: 'Manager account activated. Log in with your new password — a login code will be emailed to you.' });
      }
      if (method === 'POST' && pathname === '/api/auth/verify') {
        const { identifier, code } = body;
        if (!identifier || !code) return sendJSON(res, 400, { error: 'Identifier and code required' });
        const u = db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(identifier, identifier);
        if (!u) return sendJSON(res, 404, { error: 'Account not found' });
        if (u.verified) return sendJSON(res, 200, { ok: true, message: 'Already verified' });
        if (!u.verification_code_hash || u.verification_code_hash !== sha256(String(code)) || new Date(u.verification_expires_at).getTime() < Date.now()) {
          const n = noteWrongAttempt(String(identifier).toLowerCase());
          if (n >= 5) { db.prepare('UPDATE users SET verification_code_hash=NULL WHERE id=?').run(u.id); return sendJSON(res, 400, { error: 'Too many wrong attempts. Request a new code.' }); }
          return sendJSON(res, 400, { error: 'Invalid or expired code' });
        }
        clearAttempts(String(identifier).toLowerCase());
        db.prepare('UPDATE users SET verified=1, verification_code_hash=NULL WHERE id=?').run(u.id);
        audit(u, 'verify_account', 'user', u.id, null, null);
        return sendJSON(res, 200, { ok: true, message: 'Verified. You can now log in.' });
      }
      if (method === 'POST' && pathname === '/api/auth/request-code') {
        const { identifier } = body;
        const u = identifier ? db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(identifier, identifier) : null;
        if (!u) return sendJSON(res, 404, { error: 'Account not found' });
        if (u.verified) return sendJSON(res, 200, { ok: true, message: 'Already verified — log in instead.' });
        const code = randCode();
        const sent = await deliverCode(u, code, 'verify');
        const err = channelError(sent.channel);
        if (err) return sendJSON(res, err.status, { error: err.error });
        db.prepare('UPDATE users SET verification_code_hash=?, verification_expires_at=? WHERE id=?').run(sha256(code), new Date(Date.now() + 15 * 60000).toISOString(), u.id);
        const out = { ok: true, channel: sent.channel, message: sent.channel === 'email' ? 'A new verification code was emailed to you.' : 'New code issued.' };
        if (sent.dev_code) out.dev_code = sent.dev_code; // DEVELOPMENT ONLY
        return sendJSON(res, 200, out);
      }
      if (method === 'POST' && pathname === '/api/auth/login') {
        const { identifier, password } = body;
        if (!identifier || !password) return sendJSON(res, 400, { error: 'Identifier and password required' });
        const u = db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(identifier, identifier);
        if (!u || u.password_hash !== hashPassword(password, u.salt)) return sendJSON(res, 401, { error: 'Invalid credentials' });
        if (u.status === 'suspended') return sendJSON(res, 403, { error: 'Account suspended' });
        if (!u.verified) return sendJSON(res, 403, { error: 'Account not verified. Enter the verification code first.', need_verification: true });
        // OTP on EVERY login, for every role: the password alone never opens
        // a dashboard. The code goes to the user's own Gmail; it is never
        // returned in the response once email is configured.
        // Limit is per account (5 codes/hour), not per IP — a shared office
        // or home NAT must not lock every user out because one logged in.
        if (!rateLimit(ip, 'login-otp:' + String(identifier).toLowerCase(), 5, 60 * 60000)) return sendJSON(res, 429, { error: 'Too many login attempts for this account. Please try again in an hour.' });
        for (const [k, rec] of loginOtpStore) if (rec.expiresAt < Date.now()) loginOtpStore.delete(k); // prune expired OTPs
        const code = randCode();
        const loginToken = randToken(24);
        const sent = await deliverCode(u, code, 'login');
        const err = channelError(sent.channel);
        if (err) return sendJSON(res, err.status, { error: err.error });
        loginOtpStore.set(loginToken, { userId: u.id, codeHash: sha256(code), expiresAt: Date.now() + 15 * 60000 });
        const out = { ok: true, otp_required: true, login_token: loginToken, channel: sent.channel, message: sent.channel === 'email' ? 'A login code was emailed to you. Enter it below.' : 'Enter the login code.' };
        if (sent.dev_code) out.dev_code = sent.dev_code; // DEVELOPMENT ONLY
        return sendJSON(res, 200, out);
      }
      if (method === 'POST' && pathname === '/api/auth/login-resend') {
        const { login_token } = body;
        const rec = login_token ? loginOtpStore.get(login_token) : null;
        if (!rec || rec.expiresAt < Date.now()) return sendJSON(res, 400, { error: 'Login session expired. Log in again with your password.' });
        if (!rateLimit(ip, 'login-resend', 5, 60 * 60000)) return sendJSON(res, 429, { error: 'Too many resends. Please try again later.' });
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(rec.userId);
        if (!u) return sendJSON(res, 400, { error: 'Login session expired. Log in again with your password.' });
        const code = randCode();
        const sent = await deliverCode(u, code, 'login');
        const err = channelError(sent.channel);
        if (err) return sendJSON(res, err.status, { error: err.error });
        loginOtpStore.set(login_token, { userId: u.id, codeHash: sha256(code), expiresAt: Date.now() + 15 * 60000 });
        const out = { ok: true, channel: sent.channel, message: sent.channel === 'email' ? 'A new login code was emailed to you.' : 'New login code issued.' };
        if (sent.dev_code) out.dev_code = sent.dev_code; // DEVELOPMENT ONLY
        return sendJSON(res, 200, out);
      }
      if (method === 'POST' && pathname === '/api/auth/login-verify') {
        const { login_token, code } = body;
        const rec = login_token ? loginOtpStore.get(login_token) : null;
        if (!rec || rec.codeHash !== sha256(String(code || '')) || rec.expiresAt < Date.now()) {
          const n = login_token ? noteWrongAttempt('login:' + login_token) : 0;
          if (n >= 5 && login_token) loginOtpStore.delete(login_token);
          return sendJSON(res, 400, { error: n >= 5 ? 'Too many wrong attempts. Log in again with your password.' : 'Invalid or expired login code' });
        }
        loginOtpStore.delete(login_token);
        clearAttempts('login:' + login_token);
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(rec.userId);
        if (!u || u.status === 'suspended') return sendJSON(res, 403, { error: 'Account suspended' });
        if (!u.verified) return sendJSON(res, 403, { error: 'Account not verified' });
        const token = randToken(32), csrf = randToken(16);
        db.prepare('INSERT INTO sessions (user_id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)').run(u.id, sha256(token), csrf, addDaysISO(30));
        setCookie(res, 'zq_session', token, { httpOnly: true, maxAge: 30 * 24 * 3600 });
        setCookie(res, 'zq_csrf', csrf);
        return sendJSON(res, 200, { ok: true, user: publicUser(u), csrfToken: csrf });
      }
      if (method === 'POST' && pathname === '/api/auth/logout') {
        const { session } = getSessionUser(req);
        if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        setCookie(res, 'zq_session', '', { httpOnly: true, expires: 'Thu, 01 Jan 1970 00:00:00 GMT' });
        return sendJSON(res, 200, { ok: true });
      }
      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const auth = requireAuth(req, res, null); if (!auth) return;
        const { old_password, new_password } = body;
        if (!old_password || !new_password || String(new_password).length < 8)
          return sendJSON(res, 400, { error: 'Old password and a new password of 8+ characters are required' });
        if (auth.user.password_hash !== hashPassword(old_password, auth.user.salt))
          return sendJSON(res, 401, { error: 'Old password is incorrect' });
        const salt = randToken(16);
        db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(new_password, salt), salt, auth.user.id);
        // Keep the current session alive; revoke every other session for safety.
        if (auth.session) db.prepare('DELETE FROM sessions WHERE user_id=? AND id!=?').run(auth.user.id, auth.session.id);
        else db.prepare('DELETE FROM sessions WHERE user_id=?').run(auth.user.id);
        audit(auth.user, 'change_password', 'user', auth.user.id, null, null);
        return sendJSON(res, 200, { ok: true, message: 'Password changed. Use the new password next time you log in.' });
      }
      if (method === 'GET' && pathname === '/api/auth/me') {
        const { user, session } = getSessionUser(req);
        if (!user) return sendJSON(res, 200, { user: null });
        return sendJSON(res, 200, { user: publicUser(user), csrfToken: session.csrf_token });
      }
      // ---- public vendors ----
      if (method === 'GET' && pathname === '/api/vendors') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const cat = url.searchParams.get('category') || '';
        const city = (url.searchParams.get('city') || '').toLowerCase();
        const all = db.prepare('SELECT * FROM vendors ORDER BY subscription_plan DESC, name').all();
        const list = all.filter(isPublicVendor).filter((v) => {
          if (cat && v.category !== cat) return false;
          if (city && !v.city.toLowerCase().includes(city)) return false;
          if (q && !(v.name.toLowerCase().includes(q) || (v.description || '').toLowerCase().includes(q) || v.city.toLowerCase().includes(q) || (v.area || '').toLowerCase().includes(q))) return false;
          return true;
        }).map(vendorPublic);
        return sendJSON(res, 200, { vendors: list });
      }
      const vendorIdMatch = pathname.match(/^\/api\/vendors\/(\d+)$/);
      if (method === 'GET' && vendorIdMatch) {
        const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(vendorIdMatch[1]));
        if (!v || !isPublicVendor(v)) return sendJSON(res, 404, { error: 'Vendor not found or not public' });
        return sendJSON(res, 200, { vendor: vendorDetail(v) });
      }
      // ---- contact / newsletter ----
      if (method === 'POST' && pathname === '/api/contact') {
        if (!rateLimit(ip, 'contact', 4, 30 * 60000)) return sendJSON(res, 429, { error: 'Too many messages. Please try again later.' });
        const { name, email, subject, message } = body;
        if (!name || !isEmail(email) || !subject || !message || String(message).trim().length < 10)
          return sendJSON(res, 400, { error: 'Name, valid email, subject and a message of 10+ characters are required' });
        db.prepare('INSERT INTO contact_messages (name,email,subject,message) VALUES (?,?,?,?)').run(name.trim(), email.trim(), subject.trim(), message.trim());
        return sendJSON(res, 201, { ok: true, message: 'Message received. We will reply soon.' });
      }
      if (method === 'POST' && pathname === '/api/newsletter') {
        if (!rateLimit(ip, 'newsletter', 5, 30 * 60000)) return sendJSON(res, 429, { error: 'Too many signups. Please try again later.' });
        const { email } = body;
        if (!isEmail(email)) return sendJSON(res, 400, { error: 'Valid email required' });
        try {
          db.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run(email.trim());
        } catch { return sendJSON(res, 200, { ok: true, message: 'You are subscribed.' }); }
        return sendJSON(res, 201, { ok: true, message: 'Subscribed to Zaiqa updates.' });
      }
      // ---- customer reviews ----
      if (method === 'POST' && pathname === '/api/reviews') {
        const auth = requireAuth(req, res, ['customer']); if (!auth) return;
        const { vendor_id, food, hygiene, value, overall, delivery, comment, photo_url } = body;
        const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(vendor_id));
        if (!v || !isPublicVendor(v)) return sendJSON(res, 404, { error: 'Vendor not public' });
        const nums = [food, hygiene, value, overall];
        if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 5)) return sendJSON(res, 400, { error: 'Food, hygiene, value and overall ratings (1-5) are required' });
        if (delivery != null && (!Number.isInteger(delivery) || delivery < 1 || delivery > 5)) return sendJSON(res, 400, { error: 'Delivery rating must be 1-5' });
        if (!v.delivery_enabled && delivery != null) return sendJSON(res, 400, { error: 'This vendor does not offer delivery, so no delivery rating applies' });
        if (!comment || String(comment).trim().length < 10) return sendJSON(res, 400, { error: 'Review comment of 10+ characters required' });
        if (photo_url != null && photo_url !== '' && (typeof photo_url !== 'string' || photo_url.length > 600 || !/^https?:\/\//.test(photo_url)))
          return sendJSON(res, 400, { error: 'Review photo must be an http(s) image URL under 600 characters' });
        const existing = db.prepare("SELECT * FROM reviews WHERE vendor_id=? AND customer_id=? AND status IN ('active','flagged')").get(v.id, auth.user.id);
        if (existing) return sendJSON(res, 409, { error: 'You already have an active review for this vendor' });
        const scan = scanReview(comment);
        const status = scan.score >= 40 ? 'flagged' : 'active';
        const r = db.prepare('INSERT INTO reviews (vendor_id,customer_id,food,hygiene,value_rating,overall,delivery,comment,photo_url,status,flag_score,flag_reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(v.id, auth.user.id, food, hygiene, value, overall, delivery || null, comment.trim(), photo_url || null, status, scan.score, scan.reasons.join('; '));
        if (status === 'flagged') audit(auth.user, 'review_auto_flagged', 'review', Number(r.lastInsertRowid), 'Safety scan score ' + scan.score, { reasons: scan.reasons });
        return sendJSON(res, 201, { ok: true, reviewId: Number(r.lastInsertRowid), status, flag_score: scan.score, reasons: scan.reasons });
      }
      const flagMatch = pathname.match(/^\/api\/reviews\/(\d+)\/flag$/);
      if (method === 'POST' && flagMatch) {
        // One anonymous flag immediately pulls a review out of the public
        // averages, so cap flagging per IP (5 per 30 min) to stop mass-flag abuse.
        if (!rateLimit(ip, 'flag', 5, 30 * 60000)) return sendJSON(res, 429, { error: 'Too many flags. Please try again later.' });
        const { user } = getSessionUser(req);
        const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(Number(flagMatch[1]));
        if (!r) return sendJSON(res, 404, { error: 'Review not found' });
        db.prepare('INSERT INTO review_flags (review_id,reporter_id,reason) VALUES (?,?,?)').run(r.id, user ? user.id : null, body.reason || 'flagged by visitor');
        if (r.status === 'active') db.prepare("UPDATE reviews SET status='flagged' WHERE id=?").run(r.id);
        return sendJSON(res, 200, { ok: true, message: 'Review flagged for moderation.' });
      }
      // ---- listing reports (any visitor can report wrong info) ----
      if (method === 'POST' && pathname === '/api/reports') {
        if (!rateLimit(ip, 'report', 5, 30 * 60000)) return sendJSON(res, 429, { error: 'Too many reports. Please try again later.' });
        const { user } = getSessionUser(req);
        const { vendor_id, menu_item_id, type, message } = body;
        const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(vendor_id));
        if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
        if (!REPORT_TYPES.includes(type)) return sendJSON(res, 400, { error: 'Report type must be one of: ' + REPORT_TYPES.join(', ') });
        if (!message || String(message).trim().length < 5 || String(message).length > 500) return sendJSON(res, 400, { error: 'A short message (5-500 characters) is required' });
        if (menu_item_id != null) {
          const m = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(Number(menu_item_id), v.id);
          if (!m) return sendJSON(res, 404, { error: 'Menu item not found for this vendor' });
        }
        const r = db.prepare('INSERT INTO listing_reports (vendor_id, menu_item_id, reporter_id, type, message) VALUES (?,?,?,?,?)')
          .run(v.id, menu_item_id != null ? Number(menu_item_id) : null, user ? user.id : null, type, message.trim());
        return sendJSON(res, 201, { ok: true, reportId: Number(r.lastInsertRowid), status: 'pending' });
      }
      // ---- saved vendors (customers only) ----
      if (pathname.startsWith('/api/saved')) {
        const auth = requireAuth(req, res, ['customer']); if (!auth) return;
        if (method === 'GET' && pathname === '/api/saved') {
          const rows = db.prepare('SELECT vendor_id FROM saved_vendors WHERE user_id=? ORDER BY created_at DESC').all(auth.user.id);
          const vendors = rows.map((r) => db.prepare('SELECT * FROM vendors WHERE id=?').get(r.vendor_id)).filter((v) => v && isPublicVendor(v)).map(vendorPublic);
          return sendJSON(res, 200, { vendors });
        }
        const sv = pathname.match(/^\/api\/saved\/(\d+)$/);
        if (!sv) return sendJSON(res, 404, { error: 'Saved route not found' });
        const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(sv[1]));
        if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
        if (method === 'POST') {
          if (!isPublicVendor(v)) return sendJSON(res, 404, { error: 'Vendor not public' });
          const ex = db.prepare('SELECT * FROM saved_vendors WHERE user_id=? AND vendor_id=?').get(auth.user.id, v.id);
          if (ex) { db.prepare('DELETE FROM saved_vendors WHERE user_id=? AND vendor_id=?').run(auth.user.id, v.id); return sendJSON(res, 200, { ok: true, saved: false }); }
          db.prepare('INSERT INTO saved_vendors (user_id, vendor_id) VALUES (?,?)').run(auth.user.id, v.id);
          return sendJSON(res, 200, { ok: true, saved: true });
        }
        if (method === 'DELETE') {
          db.prepare('DELETE FROM saved_vendors WHERE user_id=? AND vendor_id=?').run(auth.user.id, v.id);
          return sendJSON(res, 200, { ok: true, saved: false });
        }
        return sendJSON(res, 404, { error: 'Saved route not found' });
      }
      // ---- manager ----
      if (pathname.startsWith('/api/manager/')) {
        const auth = requireAuth(req, res, ['manager']); if (!auth) return;
        const myVendor = () => db.prepare('SELECT * FROM vendors WHERE manager_id=?').get(auth.user.id);
        if (method === 'GET' && pathname === '/api/manager/vendor') {
          const v = myVendor();
          if (!v) return sendJSON(res, 200, { vendor: null });
          const out = { ...v, open: !!v.open, delivery_enabled: !!v.delivery_enabled };
          out.menu = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY id').all(v.id);
          out.gallery = db.prepare('SELECT * FROM gallery_items WHERE vendor_id=? ORDER BY id').all(v.id);
          out.update_requests = db.prepare('SELECT * FROM vendor_update_requests WHERE vendor_id=? ORDER BY id DESC').all(v.id);
          out.payments = db.prepare('SELECT * FROM payments WHERE manager_id=? ORDER BY id DESC').all(auth.user.id);
          out.certificates = db.prepare('SELECT * FROM certificates WHERE manager_id=? ORDER BY id DESC').all(auth.user.id);
          out.reviews = db.prepare("SELECT r.*, u.name AS customer_name FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.vendor_id=? ORDER BY r.created_at DESC").all(v.id);
          out.hours = vendorHours(v.id);
          out.reports = db.prepare('SELECT * FROM listing_reports WHERE vendor_id=? ORDER BY created_at DESC LIMIT 20').all(v.id);
          return sendJSON(res, 200, { vendor: out });
        }
        if (method === 'POST' && pathname === '/api/manager/vendors') {
          const existing = myVendor();
          if (existing && existing.status !== 'rejected')
            return sendJSON(res, 409, { error: 'You already have one vendor submission. Use update requests to change sensitive fields.' });
          if (existing) {
            // A rejected vendor can be resubmitted from scratch: the old row
            // (menu/gallery/update-requests cascade) is removed first so the
            // manager is not stuck forever with a dead listing.
            audit(auth.user, 'vendor_resubmit_after_reject', 'vendor', existing.id, null, { name: existing.name });
            db.prepare('DELETE FROM vendors WHERE id=?').run(existing.id);
          }
          const { name, category, city, area, address, description, delivery_phone, google_maps_url, primary_image_url, banner_url, delivery_enabled, delivery_fee_pkr, min_order_pkr, delivery_time, halal_declared, payment_methods } = body;
          if (payment_methods !== undefined) {
            const parts = String(payment_methods).split(',').map((x) => x.trim()).filter(Boolean);
            if (!parts.length || parts.some((x) => !VENDOR_PAYMENT_METHODS.includes(x)))
              return sendJSON(res, 400, { error: 'Payment methods must be from: ' + VENDOR_PAYMENT_METHODS.join(', ') });
          }
          if (!name || !CATEGORIES.includes(category) || !city) return sendJSON(res, 400, { error: 'Name, valid category and city are required' });
          if ((delivery_fee_pkr !== undefined && (!Number.isFinite(Number(delivery_fee_pkr)) || Number(delivery_fee_pkr) < 0)) ||
              (min_order_pkr !== undefined && (!Number.isFinite(Number(min_order_pkr)) || Number(min_order_pkr) < 0)))
            return sendJSON(res, 400, { error: 'Delivery fee and minimum order must be 0 or more PKR' });
          let slug = slugify(body.slug || name);
          let base = slug, n = 2;
          while (db.prepare('SELECT id FROM vendors WHERE slug=?').get(slug)) slug = base + '-' + (n++);
          const r = db.prepare(`INSERT INTO vendors (manager_id,name,slug,category,city,area,address,description,delivery_phone,google_maps_url,primary_image_url,banner_url,status,delivery_enabled,delivery_fee_pkr,min_order_pkr,delivery_time,halal_declared,payment_methods)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(auth.user.id, name.trim(), slug, category, city.trim(), area || '', address || '', description || '', delivery_phone || '', google_maps_url || '', primary_image_url || '', banner_url || '', 'pending', delivery_enabled ? 1 : 0, Number(delivery_fee_pkr) || 0, Number(min_order_pkr) || 0, delivery_time || '', halal_declared ? 1 : 0, payment_methods || 'Cash on Delivery');
          audit(auth.user, 'vendor_submit', 'vendor', Number(r.lastInsertRowid), null, { name });
          return sendJSON(res, 201, { ok: true, vendorId: Number(r.lastInsertRowid), slug, status: 'pending' });
        }
        const mvMatch = pathname.match(/^\/api\/manager\/vendors\/(\d+)$/);
        if (method === 'PATCH' && mvMatch) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(mvMatch[1]), auth.user.id);
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (v.status === 'suspended') return sendJSON(res, 403, { error: 'Suspended vendor is locked until admin review' });
          if (body.payment_methods !== undefined) {
            const parts = String(body.payment_methods).split(',').map((x) => x.trim()).filter(Boolean);
            if (!parts.length || parts.some((x) => !VENDOR_PAYMENT_METHODS.includes(x)))
              return sendJSON(res, 400, { error: 'Payment methods must be from: ' + VENDOR_PAYMENT_METHODS.join(', ') });
            body.payment_methods = parts.join(', ');
          }
          const bad = Object.keys(body).filter((k) => SENSITIVE_FIELDS.includes(k));
          if (bad.length) return sendJSON(res, 400, { error: 'Sensitive fields must go through an update request: ' + bad.join(', ') });
          for (const k of ['delivery_fee_pkr', 'min_order_pkr']) {
            if (body[k] !== undefined && (!Number.isFinite(Number(body[k])) || Number(body[k]) < 0))
              return sendJSON(res, 400, { error: 'Delivery fee and minimum order must be 0 or more PKR' });
          }
          const sets = [], vals = [];
          for (const k of NON_SENSITIVE_VENDOR_FIELDS) {
            if (body[k] !== undefined) { sets.push(k + '=?'); vals.push(k === 'open' || k === 'delivery_enabled' || k === 'halal_declared' ? (body[k] ? 1 : 0) : body[k]); }
          }
          if (!sets.length) return sendJSON(res, 400, { error: 'No editable fields provided' });
          if (body.category && !CATEGORIES.includes(body.category)) return sendJSON(res, 400, { error: 'Invalid category' });
          db.prepare(`UPDATE vendors SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, v.id);
          if (v.status === 'approved') db.prepare("UPDATE vendors SET status='pending_update' WHERE id=?").run(v.id);
          audit(auth.user, 'vendor_edit', 'vendor', v.id, null, { fields: Object.keys(body) });
          return sendJSON(res, 200, { ok: true });
        }
        const urMatch = pathname.match(/^\/api\/manager\/vendors\/(\d+)\/update-request$/);
        if (method === 'POST' && urMatch) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(urMatch[1]), auth.user.id);
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const fields = {};
          for (const k of SENSITIVE_FIELDS) if (body[k] !== undefined) fields[k] = body[k];
          if (!Object.keys(fields).length) return sendJSON(res, 400, { error: 'Provide at least one sensitive field: ' + SENSITIVE_FIELDS.join(', ') });
          if (fields.slug) {
            const s = slugify(fields.slug);
            const clash = db.prepare('SELECT id FROM vendors WHERE slug=? AND id!=?').get(s, v.id);
            if (clash) return sendJSON(res, 400, { error: 'Slug already in use' });
            fields.slug = s;
          }
          const r = db.prepare('INSERT INTO vendor_update_requests (vendor_id,manager_id,fields_json) VALUES (?,?,?)').run(v.id, auth.user.id, JSON.stringify(fields));
          if (v.status === 'approved') db.prepare("UPDATE vendors SET status='pending_update' WHERE id=?").run(v.id);
          audit(auth.user, 'vendor_update_request', 'vendor', v.id, null, { fields });
          return sendJSON(res, 201, { ok: true, requestId: Number(r.lastInsertRowid) });
        }
        if (method === 'POST' && pathname === '/api/manager/payments') {
          const { plan, method, reference_text, vendor_id, proof_filename, proof_mimetype, proof_base64 } = body;
          const planRow = getPlan(plan); // published plans only — an unpublished plan cannot be bought
          if (!planRow) return sendJSON(res, 400, { error: 'That plan is not available. Pick a published plan from the Plans page.' });
          if (!PAYMENT_METHODS.includes(method)) return sendJSON(res, 400, { error: 'Invalid payment method' });
          let proof = null;
          if (proof_filename || proof_base64) {
            const saved = saveUpload({ filename: proof_filename, mimetype: proof_mimetype, base64: proof_base64 });
            if (saved.error) return sendJSON(res, 400, { error: saved.error });
            proof = saved;
          }
          const v = myVendor();
          // A supplied vendor_id must belong to this manager — never trust a
          // body id to attach a payment to someone else's vendor.
          let vendorId = v ? v.id : null;
          if (vendor_id !== undefined && vendor_id !== null && vendor_id !== '') {
            const target = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(vendor_id), auth.user.id);
            if (!target) return sendJSON(res, 403, { error: 'That vendor does not belong to your account' });
            vendorId = target.id;
          }
          const r = db.prepare('INSERT INTO payments (manager_id,vendor_id,plan,amount_pkr,method,reference_text,proof_path,proof_mimetype) VALUES (?,?,?,?,?,?,?,?)')
            .run(auth.user.id, vendorId, plan, planRow.price, method, reference_text || '', proof ? proof.path : null, proof ? proof.mimetype : null);
          audit(auth.user, 'payment_submit', 'payment', Number(r.lastInsertRowid), null, { plan, method });
          return sendJSON(res, 201, { ok: true, paymentId: Number(r.lastInsertRowid), amount_pkr: planRow.price, status: 'pending' });
        }
        if (method === 'POST' && pathname === '/api/manager/certificates') {
          const { cert_type, vendor_id, file_filename, file_mimetype, file_base64 } = body;
          if (!cert_type) return sendJSON(res, 400, { error: 'Certificate type required (e.g. Food Licence, FBR, Trade Licence)' });
          let saved = null;
          if (file_filename || file_base64) {
            saved = saveUpload({ filename: file_filename, mimetype: file_mimetype, base64: file_base64 });
            if (saved.error) return sendJSON(res, 400, { error: saved.error });
          }
          const v = myVendor();
          // Same ownership rule as payments: a supplied vendor_id must be
          // this manager's own vendor.
          let vendorId = v ? v.id : null;
          if (vendor_id !== undefined && vendor_id !== null && vendor_id !== '') {
            const target = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(vendor_id), auth.user.id);
            if (!target) return sendJSON(res, 403, { error: 'That vendor does not belong to your account' });
            vendorId = target.id;
          }
          const r = db.prepare('INSERT INTO certificates (manager_id,vendor_id,cert_type,file_path,file_mimetype) VALUES (?,?,?,?,?)')
            .run(auth.user.id, vendorId, cert_type, saved ? saved.path : null, saved ? saved.mimetype : null);
          audit(auth.user, 'certificate_submit', 'certificate', Number(r.lastInsertRowid), null, { cert_type });
          return sendJSON(res, 201, { ok: true, certificateId: Number(r.lastInsertRowid), status: 'pending' });
        }
        if (method === 'POST' && pathname === '/api/manager/menu') {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Submit a vendor first' });
          const { name, description, price_pkr, category, image_url } = body;
          if (!name || price_pkr == null || !Number.isFinite(Number(price_pkr)) || Number(price_pkr) < 0) return sendJSON(res, 400, { error: 'Menu name and non-negative PKR price required' });
          const r = db.prepare('INSERT INTO menu_items (vendor_id,name,description,price_pkr,category,image_url) VALUES (?,?,?,?,?,?)').run(v.id, name, description || '', Number(price_pkr), category || '', image_url || '');
          return sendJSON(res, 201, { ok: true, menuId: Number(r.lastInsertRowid) });
        }
        const menuMatch = pathname.match(/^\/api\/manager\/menu\/(\d+)$/);
        if ((method === 'PATCH' || method === 'DELETE') && menuMatch) {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const m = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(Number(menuMatch[1]), v.id);
          if (!m) return sendJSON(res, 404, { error: 'Menu item not found' });
          if (method === 'DELETE') { db.prepare('DELETE FROM menu_items WHERE id=?').run(m.id); return sendJSON(res, 200, { ok: true }); }
          if (body.price_pkr !== undefined && (!Number.isFinite(Number(body.price_pkr)) || Number(body.price_pkr) < 0))
            return sendJSON(res, 400, { error: 'Menu price must be 0 or more PKR' });
          const sets = [], vals = [];
          for (const k of ['name', 'description', 'price_pkr', 'category', 'image_url', 'available']) {
            if (body[k] !== undefined) { sets.push(k + '=?'); vals.push(k === 'available' ? (body[k] ? 1 : 0) : body[k]); }
          }
          if (sets.length) db.prepare(`UPDATE menu_items SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, m.id);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'POST' && pathname === '/api/manager/gallery') {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Submit a vendor first' });
          if (!body.url) return sendJSON(res, 400, { error: 'Image URL required' });
          const r = db.prepare('INSERT INTO gallery_items (vendor_id,url,caption) VALUES (?,?,?)').run(v.id, body.url, body.caption || '');
          return sendJSON(res, 201, { ok: true, galleryId: Number(r.lastInsertRowid), status: 'pending' });
        }
        if (method === 'POST' && pathname === '/api/manager/staff') {
          const v = myVendor(); if (!v) return sendJSON(res, 404, { error: 'Submit a vendor first' });
          const { name, email, password } = body;
          if (!name || !isEmail(email) || !password || password.length < 8) return sendJSON(res, 400, { error: 'Staff name, valid email and 8+ password required' });
          const salt = randToken(16);
          try {
            const r = db.prepare('INSERT INTO users (name,email,contact_type,role,password_hash,salt,verified) VALUES (?,?,?,?,?,?,1)').run(name, email, 'email', 'staff', hashPassword(password, salt), salt);
            db.prepare('INSERT INTO staff_assignments (staff_id,vendor_id) VALUES (?,?)').run(Number(r.lastInsertRowid), v.id);
            audit(auth.user, 'staff_create', 'user', Number(r.lastInsertRowid), null, { vendor_id: v.id });
            return sendJSON(res, 201, { ok: true, staffId: Number(r.lastInsertRowid) });
          } catch { return sendJSON(res, 409, { error: 'Email already registered' }); }
        }
        const hoursMatch = pathname.match(/^\/api\/manager\/vendors\/(\d+)\/hours$/);
        if (method === 'POST' && hoursMatch) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=? AND manager_id=?').get(Number(hoursMatch[1]), auth.user.id);
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const hours = body.hours;
          if (!Array.isArray(hours) || hours.length > 7) return sendJSON(res, 400, { error: 'hours must be an array of up to 7 day rows' });
          const seen = new Set();
          for (const h of hours) {
            if (!Number.isInteger(h.day) || h.day < 0 || h.day > 6 || seen.has(h.day)) return sendJSON(res, 400, { error: 'Each day 0-6 may appear once' });
            seen.add(h.day);
            if (!h.closed) {
              const o = parseClock(h.open), c = parseClock(h.close);
              if (o == null || c == null || o >= c) return sendJSON(res, 400, { error: 'Each open day needs valid open/close times (HH:MM, open before close)' });
            }
          }
          db.prepare('DELETE FROM vendor_hours WHERE vendor_id=?').run(v.id);
          const ins = db.prepare('INSERT INTO vendor_hours (vendor_id, day_of_week, open_time, close_time, closed) VALUES (?,?,?,?,?)');
          for (const h of hours) ins.run(v.id, h.day, h.closed ? null : h.open, h.closed ? null : h.close, h.closed ? 1 : 0);
          audit(auth.user, 'vendor_hours_set', 'vendor', v.id, null, { days: hours.length });
          return sendJSON(res, 200, { ok: true, hours: vendorHours(v.id) });
        }
        return sendJSON(res, 404, { error: 'Manager route not found' });
      }
      // ---- staff (assigned vendor, menu/availability only) ----
      if (pathname.startsWith('/api/staff/')) {
        const auth = requireAuth(req, res, ['staff']); if (!auth) return;
        const assignment = db.prepare('SELECT * FROM staff_assignments WHERE staff_id=?').get(auth.user.id);
        if (!assignment) return sendJSON(res, 403, { error: 'No vendor assigned to this staff account' });
        const vendorId = assignment.vendor_id;
        if (method === 'GET' && pathname === '/api/staff/vendor') {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId);
          const menu = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY id').all(vendorId);
          return sendJSON(res, 200, { vendor: v, menu });
        }
        if (method === 'POST' && pathname === '/api/staff/menu') {
          if (!body.name || body.price_pkr == null || !Number.isFinite(Number(body.price_pkr)) || Number(body.price_pkr) < 0) return sendJSON(res, 400, { error: 'Name and non-negative PKR price required' });
          const r = db.prepare('INSERT INTO menu_items (vendor_id,name,description,price_pkr,category,image_url) VALUES (?,?,?,?,?,?)').run(vendorId, body.name, body.description || '', Number(body.price_pkr), body.category || '', body.image_url || '');
          return sendJSON(res, 201, { ok: true, menuId: Number(r.lastInsertRowid) });
        }
        const sm = pathname.match(/^\/api\/staff\/menu\/(\d+)$/);
        if ((method === 'PATCH' || method === 'DELETE') && sm) {
          const m = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(Number(sm[1]), vendorId);
          if (!m) return sendJSON(res, 404, { error: 'Menu item not found for assigned vendor' });
          if (method === 'DELETE') { db.prepare('DELETE FROM menu_items WHERE id=?').run(m.id); return sendJSON(res, 200, { ok: true }); }
          if (body.price_pkr !== undefined && (!Number.isFinite(Number(body.price_pkr)) || Number(body.price_pkr) < 0))
            return sendJSON(res, 400, { error: 'Menu price must be 0 or more PKR' });
          const sets = [], vals = [];
          for (const k of ['name', 'description', 'price_pkr', 'category', 'image_url', 'available']) {
            if (body[k] !== undefined) { sets.push(k + '=?'); vals.push(k === 'available' ? (body[k] ? 1 : 0) : body[k]); }
          }
          if (sets.length) db.prepare(`UPDATE menu_items SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, m.id);
          return sendJSON(res, 200, { ok: true });
        }
        return sendJSON(res, 403, { error: 'Staff accounts may only manage menu/availability for their assigned vendor' });
      }
      // ---- admin (owner only) ----
      if (pathname.startsWith('/api/admin/')) {
        const auth = requireAuth(req, res, ['owner']); if (!auth) return;
        if (method === 'GET' && pathname === '/api/admin/vendors') {
          const rows = db.prepare('SELECT v.*, u.name AS manager_name, u.email AS manager_email FROM vendors v LEFT JOIN users u ON u.id=v.manager_id ORDER BY v.created_at DESC').all();
          return sendJSON(res, 200, { vendors: rows.map((v) => ({ ...v, open: !!v.open, delivery_enabled: !!v.delivery_enabled, ratings: vendorRatings(v.id) })) });
        }
        const av = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/(approve|reject|suspend|unsuspend)$/);
        if (method === 'POST' && av) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(av[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          const action = av[2];
          if (action === 'approve') {
            db.prepare("UPDATE vendors SET status='approved', approved_at=COALESCE(approved_at, datetime('now')), rejection_reason=NULL, suspension_reason=NULL WHERE id=?").run(v.id);
          } else if (action === 'reject') {
            if (!body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
            db.prepare("UPDATE vendors SET status='rejected', rejection_reason=? WHERE id=?").run(body.reason, v.id);
          } else if (action === 'suspend') {
            if (!body.reason) return sendJSON(res, 400, { error: 'Suspension reason required' });
            db.prepare("UPDATE vendors SET status='suspended', suspension_reason=? WHERE id=?").run(body.reason, v.id);
          } else {
            // Unsuspend restores the vendor to approved ONLY if it was
            // approved before; a never-approved vendor goes back to pending
            // instead of silently becoming "approved" without an approval.
            if (v.approved_at) db.prepare("UPDATE vendors SET status='approved', suspension_reason=NULL WHERE id=?").run(v.id);
            else db.prepare("UPDATE vendors SET status='pending', suspension_reason=NULL WHERE id=?").run(v.id);
          }
          audit(auth.user, 'vendor_' + action, 'vendor', v.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        const ee = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/emergency-edit$/);
        if (method === 'POST' && ee) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(ee[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (!body.reason || String(body.reason).trim().length < 5) return sendJSON(res, 400, { error: 'Emergency edit requires a safety reason (5+ chars)' });
          const allowed = [...SENSITIVE_FIELDS, ...NON_SENSITIVE_VENDOR_FIELDS, 'status', 'halal_verified'];
          if (body.fields && body.fields.status !== undefined && !['pending', 'approved', 'pending_update', 'rejected', 'suspended'].includes(body.fields.status))
            return sendJSON(res, 400, { error: 'Invalid vendor status' });
          const sets = [], vals = [];
          for (const k of allowed) if (body.fields && body.fields[k] !== undefined) { sets.push(k + '=?'); vals.push(body.fields[k]); }
          if (!sets.length) return sendJSON(res, 400, { error: 'No fields to edit' });
          db.prepare(`UPDATE vendors SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, v.id);
          audit(auth.user, 'vendor_emergency_edit', 'vendor', v.id, body.reason, { fields: body.fields });
          return sendJSON(res, 200, { ok: true });
        }
        const del = pathname.match(/^\/api\/admin\/vendors\/(\d+)$/);
        if (method === 'DELETE' && del) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(del[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (!body.reason || String(body.reason).trim().length < 5) return sendJSON(res, 400, { error: 'Emergency delete requires a safety reason (5+ chars)' });
          audit(auth.user, 'vendor_emergency_delete', 'vendor', v.id, body.reason, { name: v.name });
          db.prepare('DELETE FROM vendors WHERE id=?').run(v.id);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/payments') return sendJSON(res, 200, { payments: db.prepare('SELECT p.*, u.name AS manager_name FROM payments p JOIN users u ON u.id=p.manager_id ORDER BY p.created_at DESC').all() });
        const pay = pathname.match(/^\/api\/admin\/payments\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && pay) {
          const p = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(pay[1]));
          if (!p) return sendJSON(res, 404, { error: 'Payment not found' });
          if (pay[2] === 'reject' && !body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
          db.prepare('UPDATE payments SET status=?, admin_note=?, decided_at=datetime(\'now\') WHERE id=?').run(pay[2] === 'approve' ? 'approved' : 'rejected', body.reason || null, p.id);
          if (pay[2] === 'approve' && p.vendor_id) {
            const plan = getPlanAny(p.plan); // any row — an unpublished plan still honours payments already submitted for it
            if (!plan) return sendJSON(res, 400, { error: 'That plan no longer exists — it was deleted. Reject this payment and ask the manager to pay for a current plan.' });
            const cur = db.prepare('SELECT subscription_expires_at FROM vendors WHERE id=?').get(p.vendor_id);
            const base = cur && cur.subscription_expires_at && new Date(cur.subscription_expires_at).getTime() > Date.now() ? new Date(cur.subscription_expires_at).getTime() : Date.now();
            db.prepare('UPDATE vendors SET subscription_plan=?, subscription_expires_at=? WHERE id=?').run(p.plan, new Date(base + plan.days * 86400000).toISOString(), p.vendor_id);
          }
          audit(auth.user, 'payment_' + pay[2], 'payment', p.id, body.reason || null, { plan: p.plan });
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/certificates') return sendJSON(res, 200, { certificates: db.prepare('SELECT c.*, u.name AS manager_name FROM certificates c JOIN users u ON u.id=c.manager_id ORDER BY c.created_at DESC').all() });
        const cert = pathname.match(/^\/api\/admin\/certificates\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && cert) {
          const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(Number(cert[1]));
          if (!c) return sendJSON(res, 404, { error: 'Certificate not found' });
          if (cert[2] === 'reject' && !body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
          db.prepare('UPDATE certificates SET status=?, admin_note=?, decided_at=datetime(\'now\') WHERE id=?').run(cert[2] === 'approve' ? 'approved' : 'rejected', body.reason || null, c.id);
          audit(auth.user, 'certificate_' + cert[2], 'certificate', c.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/update-requests') return sendJSON(res, 200, { requests: db.prepare('SELECT r.*, v.name AS vendor_name FROM vendor_update_requests r JOIN vendors v ON v.id=r.vendor_id ORDER BY r.created_at DESC').all() });
        const upd = pathname.match(/^\/api\/admin\/update-requests\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && upd) {
          const r = db.prepare('SELECT * FROM vendor_update_requests WHERE id=?').get(Number(upd[1]));
          if (!r) return sendJSON(res, 404, { error: 'Update request not found' });
          if (upd[2] === 'approve') {
            const fields = JSON.parse(r.fields_json);
            // Re-check slug uniqueness at approval time, not just at request
            // time — another vendor may have taken the slug since.
            if (fields.slug) {
              const clash = db.prepare('SELECT id FROM vendors WHERE slug=? AND id!=?').get(slugify(fields.slug), r.vendor_id);
              if (clash) return sendJSON(res, 400, { error: 'Slug already in use by another vendor — reject this request and ask the manager to choose another slug' });
            }
            const sets = [], vals = [];
            for (const k of SENSITIVE_FIELDS) if (fields[k] !== undefined) { sets.push(k + '=?'); vals.push(fields[k]); }
            if (sets.length) db.prepare(`UPDATE vendors SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, r.vendor_id);
            const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(r.vendor_id);
            if (v && v.status === 'pending_update' && v.approved_at) db.prepare("UPDATE vendors SET status='approved' WHERE id=?").run(v.id);
          } else if (!body.reason) return sendJSON(res, 400, { error: 'Rejection reason required' });
          db.prepare('UPDATE vendor_update_requests SET status=?, admin_note=?, decided_at=datetime(\'now\') WHERE id=?').run(upd[2] === 'approve' ? 'approved' : 'rejected', body.reason || null, r.id);
          audit(auth.user, 'update_request_' + upd[2], 'vendor_update_request', r.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/gallery') return sendJSON(res, 200, { gallery: db.prepare('SELECT g.*, v.name AS vendor_name FROM gallery_items g JOIN vendors v ON v.id=g.vendor_id ORDER BY g.created_at DESC').all() });
        const gal = pathname.match(/^\/api\/admin\/gallery\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && gal) {
          const g = db.prepare('SELECT * FROM gallery_items WHERE id=?').get(Number(gal[1]));
          if (!g) return sendJSON(res, 404, { error: 'Image not found' });
          db.prepare('UPDATE gallery_items SET status=? WHERE id=?').run(gal[2] === 'approve' ? 'approved' : 'rejected', g.id);
          audit(auth.user, 'gallery_' + gal[2], 'gallery', g.id, null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/reviews') return sendJSON(res, 200, { reviews: db.prepare('SELECT r.*, v.name AS vendor_name, u.name AS customer_name FROM reviews r JOIN vendors v ON v.id=r.vendor_id JOIN users u ON u.id=r.customer_id ORDER BY r.created_at DESC').all() });
        const rev = pathname.match(/^\/api\/admin\/reviews\/(\d+)\/(note|reply|delete|restore)$/);
        if (method === 'POST' && rev) {
          const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(Number(rev[1]));
          if (!r) return sendJSON(res, 404, { error: 'Review not found' });
          const action = rev[2];
          if (action === 'note') {
            if (!body.note) return sendJSON(res, 400, { error: 'Note required' });
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'note', body.note);
          } else if (action === 'reply') {
            if (!body.reply) return sendJSON(res, 400, { error: 'Reply required' });
            db.prepare('UPDATE reviews SET admin_reply=? WHERE id=?').run(body.reply, r.id);
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'reply', body.reply);
          } else if (action === 'delete') {
            db.prepare("UPDATE reviews SET status='deleted' WHERE id=?").run(r.id);
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'soft_delete', body.reason || '');
          } else if (action === 'restore') {
            db.prepare("UPDATE reviews SET status='active' WHERE id=?").run(r.id);
            db.prepare('INSERT INTO review_moderation (review_id,admin_id,action,note) VALUES (?,?,?,?)').run(r.id, auth.user.id, 'restore', body.reason || '');
          }
          audit(auth.user, 'review_' + action, 'review', r.id, body.reason || body.note || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        const vh = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/verify-halal$/);
        if (method === 'POST' && vh) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(vh[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          db.prepare('UPDATE vendors SET halal_verified=1 WHERE id=?').run(v.id);
          audit(auth.user, 'vendor_halal_verified', 'vendor', v.id, null, null);
          return sendJSON(res, 200, { ok: true });
        }
        const asg = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/(assign|unassign)$/);
        if (method === 'POST' && asg) {
          const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(asg[1]));
          if (!v) return sendJSON(res, 404, { error: 'Vendor not found' });
          if (asg[2] === 'unassign') {
            db.prepare('UPDATE vendors SET manager_id=NULL WHERE id=?').run(v.id);
            audit(auth.user, 'vendor_unassign', 'vendor', v.id, null, null);
            return sendJSON(res, 200, { ok: true, manager_id: null });
          }
          const m = db.prepare("SELECT * FROM users WHERE email=?").get(String(body.manager_email || '').trim().toLowerCase());
          if (!m) return sendJSON(res, 404, { error: 'No account with that email — create the manager from the Admin panel first' });
          if (m.role !== 'manager') return sendJSON(res, 400, { error: 'That account is not a manager (role: ' + m.role + ')' });
          if (m.status !== 'active') return sendJSON(res, 400, { error: 'That manager account is suspended' });
          if (v.manager_id) return sendJSON(res, 409, { error: 'This vendor already has a manager — unassign first' });
          const already = db.prepare('SELECT id FROM vendors WHERE manager_id=?').get(m.id);
          if (already) return sendJSON(res, 409, { error: 'That manager already has a vendor (one vendor per manager)' });
          db.prepare('UPDATE vendors SET manager_id=? WHERE id=?').run(m.id, v.id);
          audit(auth.user, 'vendor_assign', 'vendor', v.id, null, { manager_id: m.id, manager_email: m.email });
          return sendJSON(res, 200, { ok: true, manager_id: m.id });
        }
        if (method === 'GET' && pathname === '/api/admin/listing-reports') {
          const rows = db.prepare("SELECT lr.*, v.name AS vendor_name, v.city AS vendor_city FROM listing_reports lr JOIN vendors v ON v.id=lr.vendor_id ORDER BY (lr.status='pending') DESC, lr.created_at DESC LIMIT 100").all();
          return sendJSON(res, 200, { reports: rows });
        }
        const lrMatch = pathname.match(/^\/api\/admin\/listing-reports\/(\d+)\/(resolve|dismiss)$/);
        if (method === 'POST' && lrMatch) {
          const r = db.prepare('SELECT * FROM listing_reports WHERE id=?').get(Number(lrMatch[1]));
          if (!r) return sendJSON(res, 404, { error: 'Report not found' });
          db.prepare('UPDATE listing_reports SET status=? WHERE id=?').run(lrMatch[2] === 'resolve' ? 'resolved' : 'dismissed', r.id);
          audit(auth.user, 'listing_report_' + lrMatch[2], 'listing_report', r.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/reports') {
          const totals = {
            vendors_total: db.prepare('SELECT COUNT(*) c FROM vendors').get().c,
            vendors_approved: db.prepare("SELECT COUNT(*) c FROM vendors WHERE status='approved'").get().c,
            vendors_pending: db.prepare("SELECT COUNT(*) c FROM vendors WHERE status='pending'").get().c,
            vendors_suspended: db.prepare("SELECT COUNT(*) c FROM vendors WHERE status='suspended'").get().c,
            users_total: db.prepare('SELECT COUNT(*) c FROM users').get().c,
            managers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='manager'").get().c,
            customers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c,
            reviews_total: db.prepare('SELECT COUNT(*) c FROM reviews').get().c,
            reviews_active: db.prepare("SELECT COUNT(*) c FROM reviews WHERE status='active'").get().c,
            payments_approved_total_pkr: db.prepare("SELECT COALESCE(SUM(amount_pkr),0) s FROM payments WHERE status='approved'").get().s,
            contacts: db.prepare('SELECT COUNT(*) c FROM contact_messages').get().c,
            listing_reports_pending: db.prepare("SELECT COUNT(*) c FROM listing_reports WHERE status='pending'").get().c,
            newsletter: db.prepare('SELECT COUNT(*) c FROM newsletter_subscribers').get().c,
          };
          const topRating = db.prepare(`SELECT v.id, v.name, v.city, v.category, AVG(r.overall) avg_overall, COUNT(r.id) n FROM vendors v JOIN reviews r ON r.vendor_id=v.id WHERE r.status='active' GROUP BY v.id ORDER BY avg_overall DESC, n DESC LIMIT 5`).all()
            .map((x) => ({ ...x, avg_overall: Math.round(x.avg_overall * 10) / 10 }));
          const topCount = db.prepare(`SELECT v.id, v.name, v.city, v.category, COUNT(r.id) n, AVG(r.overall) avg_overall FROM vendors v JOIN reviews r ON r.vendor_id=v.id WHERE r.status='active' GROUP BY v.id ORDER BY n DESC LIMIT 5`).all()
            .map((x) => ({ ...x, avg_overall: Math.round(x.avg_overall * 10) / 10 }));
          const categoryTotals = db.prepare('SELECT category, COUNT(*) n FROM vendors GROUP BY category ORDER BY n DESC').all();
          const staleMenus = db.prepare(`SELECT v.id, v.name, v.city, MAX(m.updated_at) last_menu_update FROM vendors v LEFT JOIN menu_items m ON m.vendor_id=v.id GROUP BY v.id HAVING last_menu_update IS NULL OR last_menu_update < datetime('now','-60 days') ORDER BY last_menu_update ASC LIMIT 10`).all();
          return sendJSON(res, 200, { totals, top_by_rating: topRating, top_by_review_count: topCount, category_totals: categoryTotals, stale_menus: staleMenus });
        }
        if (method === 'GET' && pathname === '/api/admin/audit-log') return sendJSON(res, 200, { log: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all() });
        if (method === 'GET' && pathname === '/api/admin/users') return sendJSON(res, 200, { users: db.prepare('SELECT id,name,email,phone,role,verified,status,created_at FROM users ORDER BY created_at DESC').all() });
        // ---- admin-managed managers: the admin creates the account, the
        // manager activates it with a setup code emailed to their Gmail.
        // There is no public manager signup any more.
        if (method === 'POST' && pathname === '/api/admin/managers') {
          const { name, email } = body;
          if (!name || !isEmail(email)) return sendJSON(res, 400, { error: 'Manager name and a valid email are required' });
          const em = email.trim().toLowerCase();
          if (db.prepare('SELECT id FROM users WHERE email=?').get(em)) return sendJSON(res, 409, { error: 'That email is already registered' });
          const code = randCode();
          const salt = randToken(16);
          // Unusable random password until the manager sets their own in setup.
          const r = db.prepare("INSERT INTO users (name,email,contact_type,role,password_hash,salt,verified,verification_code_hash,verification_expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(name.trim(), em, 'email', 'manager', hashPassword(randToken(24), salt), salt, 0, sha256(code), new Date(Date.now() + 15 * 60000).toISOString());
          const managerId = Number(r.lastInsertRowid);
          const sent = await deliverCode({ email: em }, code, 'manager-setup');
          const err = channelError(sent.channel);
          if (err) { db.prepare('DELETE FROM users WHERE id=?').run(managerId); return sendJSON(res, err.status, { error: err.error }); }
          audit(auth.user, 'manager_create', 'user', managerId, null, { email: em });
          const out = { ok: true, managerId, channel: sent.channel, message: sent.channel === 'email' ? 'Manager account created. The setup code was emailed to them.' : 'Manager account created.' };
          if (sent.dev_code) out.dev_code = sent.dev_code; // DEVELOPMENT ONLY
          return sendJSON(res, 201, out);
        }
        // ---- admin-published plans ----
        if (method === 'GET' && pathname === '/api/admin/plans') {
          return sendJSON(res, 200, { plans: db.prepare('SELECT * FROM plans ORDER BY price_pkr ASC').all() });
        }
        if (method === 'POST' && pathname === '/api/admin/plans') {
          const { name, days, price_pkr } = body;
          const nm = String(name || '').trim();
          if (!nm || nm.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(nm)) return sendJSON(res, 400, { error: 'Plan name required (letters, numbers, spaces, hyphens, max 40 chars)' });
          if (!Number.isInteger(days) || days < 1 || days > 365) return sendJSON(res, 400, { error: 'Plan days must be 1-365' });
          if (!Number.isInteger(price_pkr) || price_pkr < 0 || price_pkr > 1000000) return sendJSON(res, 400, { error: 'Plan price must be 0-1,000,000 PKR' });
          try {
            const r = db.prepare('INSERT INTO plans (name, days, price_pkr, published) VALUES (?,?,?,1)').run(nm, days, price_pkr);
            audit(auth.user, 'plan_create', 'plan', Number(r.lastInsertRowid), null, { name: nm, days, price_pkr });
            return sendJSON(res, 201, { ok: true, planId: Number(r.lastInsertRowid) });
          } catch { return sendJSON(res, 409, { error: 'A plan with that name already exists' }); }
        }
        const planMatch = pathname.match(/^\/api\/admin\/plans\/(\d+)$/);
        if (method === 'PATCH' && planMatch) {
          const p = db.prepare('SELECT * FROM plans WHERE id=?').get(Number(planMatch[1]));
          if (!p) return sendJSON(res, 404, { error: 'Plan not found' });
          const sets = [], vals = [];
          if (body.name !== undefined) {
            const nm = String(body.name).trim();
            if (!nm || nm.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(nm)) return sendJSON(res, 400, { error: 'Plan name invalid (letters, numbers, spaces, hyphens, max 40 chars)' });
            sets.push('name=?'); vals.push(nm);
          }
          if (body.days !== undefined) {
            if (!Number.isInteger(body.days) || body.days < 1 || body.days > 365) return sendJSON(res, 400, { error: 'Plan days must be 1-365' });
            sets.push('days=?'); vals.push(body.days);
          }
          if (body.price_pkr !== undefined) {
            if (!Number.isInteger(body.price_pkr) || body.price_pkr < 0 || body.price_pkr > 1000000) return sendJSON(res, 400, { error: 'Plan price must be 0-1,000,000 PKR' });
            sets.push('price_pkr=?'); vals.push(body.price_pkr);
          }
          if (body.published !== undefined) { sets.push('published=?'); vals.push(body.published ? 1 : 0); }
          if (!sets.length) return sendJSON(res, 400, { error: 'No fields to update' });
          try {
            db.prepare(`UPDATE plans SET ${sets.join(',')} WHERE id=?`).run(...vals, p.id);
          } catch { return sendJSON(res, 409, { error: 'A plan with that name already exists' }); }
          audit(auth.user, 'plan_update', 'plan', p.id, null, { fields: Object.keys(body) });
          return sendJSON(res, 200, { ok: true });
        }
        const usr = pathname.match(/^\/api\/admin\/users\/(\d+)\/(suspend|activate)$/);
        if (method === 'POST' && usr) {
          const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(usr[1]));
          if (!u) return sendJSON(res, 404, { error: 'User not found' });
          if (u.role === 'owner') return sendJSON(res, 403, { error: 'Cannot suspend the Portal Admin' });
          db.prepare('UPDATE users SET status=? WHERE id=?').run(usr[2] === 'suspend' ? 'suspended' : 'active', u.id);
          if (usr[2] === 'suspend') db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
          audit(auth.user, 'user_' + usr[2], 'user', u.id, body.reason || null, null);
          return sendJSON(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/admin/contacts') return sendJSON(res, 200, { contacts: db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100').all() });
        if (method === 'GET' && pathname === '/api/admin/activity') {
          const rows = db.prepare('SELECT substr(created_at,1,10) d, COUNT(*) n FROM reviews GROUP BY d ORDER BY d DESC LIMIT 14').all().reverse();
          return sendJSON(res, 200, { activity: rows });
        }
        return sendJSON(res, 404, { error: 'Admin route not found' });
      }
      return sendJSON(res, 404, { error: 'API route not found' });
    }
    // Static files (SPA fallback for hash routes is client-side; / serves index)
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Server error: ' + e.message });
    else res.end();
  }
}

const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log(`Zaiqa running at http://localhost:${PORT}`);
  console.log('Admin: from ADMIN_EMAIL env (no demo accounts in code)');
});
