// Zaiqa test suite — HTTP end-to-end against a FRESH temp copy of the app.
// Run: node test.js   (exit 0 = all pass, exit 1 = failures)
// The suite copies server.js + public/ + sql/ into a temp dir so the real
// ~/workspace/zaiqa/app/zaiqa.sqlite is NEVER touched. All accounts use
// dummy credentials only. No GitHub, no live container.
// The suite runs in NODE_ENV=development with NO email configured, so the
// dev channel returns codes in responses (dev_code). A second boot at the
// end runs in production mode with no email to prove the fail-closed
// behaviour: no code is ever returned and no unverifiable account is made.
// A third boot runs in production with a stub Brevo API (local HTTP server)
// to prove the real email channel end to end: register + login OTP arrive
// as Brevo requests and the code in the email verifies the account.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 3019;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

// ---- tiny HTTP client with cookie jar ----
class Client {
  constructor() { this.cookies = {}; }
  async req(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.Cookie = ck;
    if (opts.csrf) headers['X-CSRF-Token'] = this.csrfToken;
    const res = await fetch(BASE + p, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.cookies[m[1]] = decodeURIComponent(m[2]);
    }
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { _text: text }; }
    return { status: res.status, json, text };
  }
  async csrf() {
    const r = await this.req('GET', '/api/csrf');
    this.csrfToken = r.json.csrfToken;
    return r;
  }
  async get(p) { return this.req('GET', p); }
  async post(p, body, useCsrf = true) { if (useCsrf) await this.csrf(); return this.req('POST', p, body, { csrf: useCsrf }); }
  async patch(p, body) { await this.csrf(); return this.req('PATCH', p, body, { csrf: true }); }
  async del(p, body) { await this.csrf(); return this.req('DELETE', p, body, { csrf: true }); }
}

// ---- test helpers for the OTP model ----
// Every login now asks for a 6-digit code (dev channel in this suite).
async function loginOtp(client, identifier, password) {
  const r = await client.post('/api/auth/login', { identifier, password }, false);
  ok('login asks OTP for ' + identifier, r.status === 200 && r.json.otp_required === true && typeof r.json.dev_code === 'string', JSON.stringify(r.json));
  const v = await client.post('/api/auth/login-verify', { login_token: r.json.login_token, code: r.json.dev_code }, false);
  ok('login-verify OK for ' + identifier, v.status === 200 && !!v.json.user, JSON.stringify(v.json));
  return v;
}
// Admin creates a manager, the manager activates with the emailed setup
// code (dev channel here), then logs in with OTP. Returns the client.
async function makeManager(adminClient, name, email) {
  const r = await adminClient.post('/api/admin/managers', { name, email });
  ok('admin creates manager ' + email, r.status === 201 && typeof r.json.dev_code === 'string', JSON.stringify(r.json));
  const c = new Client();
  const s = await c.post('/api/auth/manager-setup', { email, code: r.json.dev_code, password: 'DummyPass1!' }, false);
  ok('manager setup ' + email, s.status === 200, JSON.stringify(s.json));
  await loginOtp(c, email, 'DummyPass1!');
  return c;
}

// ---- boot a fresh copy ----
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaiqa-test-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'sql'), path.join(tmp, 'sql'), { recursive: true });
  const child = spawn('node', ['server.js'], {
    cwd: tmp, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', ADMIN_EMAIL: 'testadmin@example.com', ADMIN_PASSWORD: 'TestAdmin1!' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    await waitForHealth();
    await runTests();
    await prodNoSmtpChecks();
    await prodBrevoChecks();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' - ' + f)); }
  process.exit(fail ? 1 : 0);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

// Production boot with NO SMTP configured: the fail-closed behaviour.
// Codes must never be returned, and no unverifiable account may be created.
const PROD_PORT = 3020;
const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;
async function prodNoSmtpChecks() {
  console.log('\n== production, no SMTP: fail-closed ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaiqa-prod-test-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'sql'), path.join(tmp, 'sql'), { recursive: true });
  const child = spawn('node', ['server.js'], {
    cwd: tmp, env: { ...process.env, PORT: String(PROD_PORT), NODE_ENV: 'production', ADMIN_EMAIL: 'prodadmin@example.com', ADMIN_PASSWORD: 'ProdAdmin1!' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { const rr = await fetch(PROD_BASE + '/api/health'); if (rr.status === 200) break; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const post = async (p, body) => {
      const res = await fetch(PROD_BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    let r = await post('/api/auth/register-customer', { name: 'Prod User', email: 'prod@example.com', password: 'DummyPass1!' });
    eq('prod register without SMTP = 503', r.status, 503);
    ok('prod register response has no code', !r.json.dev_code);
    r = await post('/api/auth/login', { identifier: 'prodadmin@example.com', password: 'ProdAdmin1!' });
    eq('prod admin login without SMTP = 503', r.status, 503);
    ok('prod login response has no code', !r.json.dev_code);
    r = await post('/api/auth/register-customer', { name: 'Phone User', phone: '03001234567', password: 'DummyPass1!' });
    eq('prod phone register = 400 (no SMS)', r.status, 400);
    // The 503 register must not have created the account:
    r = await post('/api/auth/login', { identifier: 'prod@example.com', password: 'DummyPass1!' });
    eq('prod unregistered email login = 401 (no account made)', r.status, 401);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Production boot with a stub Brevo API: the real email channel, end to end.
// The stub first rejects (401) to prove a Brevo failure fails closed, then
// accepts (201) and the code captured from the stubbed email must verify.
const BREVO_PORT = 3021;
const BREVO_STUB = 'http://127.0.0.1:' + BREVO_PORT;
const BREVO_PROD_PORT = 3022;
const BREVO_PROD_BASE = 'http://127.0.0.1:' + BREVO_PROD_PORT;
async function prodBrevoChecks() {
  console.log('\n== production, stub Brevo API: real email channel ==');
  const seen = []; // captured Brevo request bodies
  let failMode = true; // start rejecting, then accept
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch {}
      seen.push({ headers: req.headers, json });
      if (failMode) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'unauthorized', message: 'Key not found' })); }
      else { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ messageId: 'stub-' + seen.length })); }
    });
  });
  await new Promise((r) => stub.listen(BREVO_PORT, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaiqa-brevo-test-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'sql'), path.join(tmp, 'sql'), { recursive: true });
  const child = spawn('node', ['server.js'], {
    cwd: tmp, env: { ...process.env, PORT: String(BREVO_PROD_PORT), NODE_ENV: 'production', ADMIN_EMAIL: 'brevoadmin@example.com', ADMIN_PASSWORD: 'BrevoAdmin1!', BREVO_API_KEY: 'xkeysib-test-key', BREVO_SENDER_EMAIL: 'zaiqa@example.com', BREVO_API_URL: BREVO_STUB + '/v3/smtp/email' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { const rr = await fetch(BREVO_PROD_BASE + '/api/health'); if (rr.status === 200) break; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const post = async (p, body) => {
      const res = await fetch(BREVO_PROD_BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    // Brevo rejecting (bad key): register fails closed, no account made.
    let r = await post('/api/auth/register-customer', { name: 'Brevo User', email: 'brevo@example.com', password: 'DummyPass1!' });
    eq('brevo 401 register = 503', r.status, 503);
    ok('brevo 401 response has no code', !r.json.dev_code);
    eq('brevo 401 sent one request to stub', seen.length, 1);
    ok('brevo request used the verified sender', seen[0].json && seen[0].json.sender && seen[0].json.sender.email === 'zaiqa@example.com', JSON.stringify(seen[0] && seen[0].json && seen[0].json.sender));
    ok('brevo request targeted the customer', seen[0].json && seen[0].json.to && seen[0].json.to[0] && seen[0].json.to[0].email === 'brevo@example.com', JSON.stringify(seen[0] && seen[0].json && seen[0].json.to));
    r = await post('/api/auth/login', { identifier: 'brevo@example.com', password: 'DummyPass1!' });
    eq('brevo 401 unregistered email login = 401 (no account made)', r.status, 401);
    // Brevo accepting: register succeeds, code lives only in the email.
    failMode = false;
    r = await post('/api/auth/register-customer', { name: 'Brevo User', email: 'brevo@example.com', password: 'DummyPass1!' });
    eq('brevo 201 register = 201', r.status, 201);
    ok('brevo 201 response has no code', !r.json.dev_code);
    eq('brevo 201 channel = email', r.json.channel, 'email');
    eq('brevo 201 sent a second request', seen.length, 2);
    const mail = seen[1].json;
    const m = mail && mail.textContent && mail.textContent.match(/(\d{6})/);
    ok('brevo email carries a 6-digit code', !!m, mail && mail.textContent);
    r = await post('/api/auth/verify', { identifier: 'brevo@example.com', code: m[1] });
    eq('brevo code from the email verifies the account', r.status, 200);
    // Admin login OTP through Brevo, then login-verify with the emailed code.
    r = await post('/api/auth/login', { identifier: 'brevoadmin@example.com', password: 'BrevoAdmin1!' });
    ok('brevo admin login = 200 otp_required', r.status === 200 && r.json.otp_required === true, JSON.stringify(r.json));
    ok('brevo admin login response has no code', !r.json.dev_code);
    eq('brevo admin login sent a third request', seen.length, 3);
    const m2 = seen[2].json && seen[2].json.textContent && seen[2].json.textContent.match(/(\d{6})/);
    ok('brevo login email carries a 6-digit code', !!m2, seen[2].json && seen[2].json.textContent);
    r = await post('/api/auth/login-verify', { login_token: r.json.login_token, code: m2[1] });
    eq('brevo login code verifies the admin', r.status, 200);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runTests() {
  const anon = new Client();
  console.log('\n== public / health ==');
  let r = await anon.get('/api/health');
  eq('health 200 ok', r.json.ok, true);
  r = await fetch(BASE + '/');
  ok('homepage 200 html', r.status === 200 && (await r.text()).includes('Zaiqa'));
  r = await anon.get('/api/plans');
  eq('plans hidden from public (manager-only)', Object.keys(r.json.plans).length, 0);
  eq('payment methods hidden from public', r.json.methods.length, 0);
  r = await anon.get('/api/categories');
  ok('categories include Karahi + BBQ', r.json.categories.includes('Karahi') && r.json.categories.includes('BBQ'));

  console.log('\n== public vendor listing (approved-only) ==');
  r = await anon.get('/api/vendors');
  eq('public vendors = 5 (2 pending hidden)', r.json.vendors.length, 5);
  ok('no pending vendor leaks', r.json.vendors.every((v) => v.status === 'approved' || v.status === 'pending_update'));
  ok('pending_update vendor 4 IS public', r.json.vendors.some((v) => v.id === 4));
  r = await anon.get('/api/vendors?q=nihari');
  eq('search nihari = 1', r.json.vendors.length, 1);
  r = await anon.get('/api/vendors?category=Karahi');
  eq('category Karahi = 1', r.json.vendors.length, 1);
  r = await anon.get('/api/vendors?city=Lahore');
  eq('city Lahore = 2', r.json.vendors.length, 2);
  r = await anon.get('/api/vendors?city=Nowhere');
  eq('city Nowhere = 0', r.json.vendors.length, 0);
  r = await anon.get('/api/vendors/6');
  eq('pending vendor detail = 404', r.status, 404);
  r = await anon.get('/api/vendors/999');
  eq('missing vendor detail = 404', r.status, 404);

  console.log('\n== vendor detail + ratings maths ==');
  r = await anon.get('/api/vendors/1');
  eq('vendor 1 menu items = 4', r.json.vendor.menu.length, 4);
  eq('vendor 1 menu prices PKR', r.json.vendor.menu.map((m) => m.price_pkr).sort((a, b) => a - b), [40, 380, 450, 850]);
  eq('vendor 1 reviews = 0 (no seeded accounts)', r.json.vendor.reviews.length, 0);
  eq('vendor 1 ratings empty, count 0', r.json.vendor.ratings, { count: 0, food: null, hygiene: null, value: null, overall: null, delivery: null });
  r = await anon.get('/api/vendors/5');
  eq('vendor 5 (no delivery) delivery rating null', r.json.vendor.ratings.delivery, null);
  ok('vendor 5 delivery_enabled false', r.json.vendor.delivery_enabled === false);

  console.log('\n== contact / newsletter ==');
  r = await anon.post('/api/contact', { name: 'Test', email: 'bad', subject: 'Hi', message: 'short' });
  eq('contact bad email = 400', r.status, 400);
  r = await anon.post('/api/contact', { name: 'Test User', email: 'test@example.com', subject: 'Hello', message: 'This is a proper test message.' });
  eq('contact valid = 201', r.status, 201);
  r = await anon.post('/api/newsletter', { email: 'news@example.com' });
  eq('newsletter = 201', r.status, 201);
  r = await anon.post('/api/newsletter', { email: 'news@example.com' });
  eq('newsletter duplicate = 200 idempotent', r.status, 200);
  r = await anon.req('POST', '/api/contact', { name: 'X', email: 'x@example.com', subject: 's', message: 'long enough message here' });
  eq('contact without CSRF = 403', r.status, 403);

  console.log('\n== customer register / verify / login / review flow ==');
  const cust = new Client();
  r = await cust.post('/api/auth/register-customer', { name: 'Test Customer', email: 'testcust@example.com', password: 'DummyPass1!' }, false);
  eq('register customer = 201 + dev code', r.status === 201 && typeof r.json.dev_code === 'string' && r.json.dev_code.length === 6, true);
  eq('register customer channel = dev (no SMTP in tests)', r.json.channel, 'dev');
  const custCode = r.json.dev_code;
  r = await cust.post('/api/auth/register-customer', { name: 'Phone User', phone: '03001234567', password: 'DummyPass1!' }, false);
  eq('phone register works in dev (code on screen)', r.status === 201 && typeof r.json.dev_code === 'string', true);
  r = await cust.post('/api/auth/register-customer', { name: 'Both', email: 'both@example.com', phone: '03001234567', password: 'DummyPass1!' }, false);
  eq('register with both channels = 400', r.status, 400);
  r = await cust.post('/api/auth/verify', { identifier: 'testcust@example.com', code: '000000' }, false);
  eq('verify wrong code = 400', r.status, 400);
  r = await cust.post('/api/auth/verify', { identifier: 'testcust@example.com', code: custCode }, false);
  eq('verify correct code = 200', r.status, 200);
  r = await cust.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'WrongPass1!' }, false);
  eq('login wrong password = 401', r.status, 401);
  await loginOtp(cust, 'testcust@example.com', 'DummyPass1!');
  r = await cust.get('/api/auth/me');
  eq('me returns customer', r.json.user && r.json.user.email, 'testcust@example.com');

  r = await cust.post('/api/reviews', { vendor_id: 6, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'Should not be allowed on pending.' });
  eq('review on pending vendor = 404', r.status, 404);
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 6, hygiene: 5, value: 5, overall: 5, comment: 'Rating out of range test here.' });
  eq('review rating 6 = 400', r.status, 400);
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'short' });
  eq('review short comment = 400', r.status, 400);
  r = await cust.post('/api/reviews', { vendor_id: 5, food: 5, hygiene: 5, value: 5, overall: 5, delivery: 4, comment: 'Great mithai, fresh and tasty.' });
  eq('delivery rating on no-delivery vendor = 400', r.status, 400);
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 4, hygiene: 4, value: 5, overall: 4, delivery: 5, comment: 'Great chapli kabab, fresh naan, quick service.' });
  eq('review submit = 201 active', r.status === 201 && r.json.status === 'active', true);
  const reviewId = r.json.reviewId;
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'Trying to post a second review here.' });
  eq('second review same vendor = 409', r.status, 409);
  r = await anon.get('/api/vendors/1');
  eq('ratings count now 1 after new review', r.json.vendor.ratings.count, 1);
  eq('overall avg now = 4 (single review)', r.json.vendor.ratings.overall, 4);
  ok('new review appears in detail', r.json.vendor.reviews.some((x) => x.id === reviewId && x.customer_name === 'Test Customer'));
  r = await cust.post('/api/reviews', { vendor_id: 1, food: 1, hygiene: 1, value: 1, overall: 1, comment: 'This review contains shit and should be flagged automatically by scan.' });
  eq('second review still 409 even if abusive', r.status, 409);

  // safety scan: fresh customer, abusive review gets flagged
  const cust2 = new Client();
  r = await cust2.post('/api/auth/register-customer', { name: 'Scan Test', email: 'scan@example.com', password: 'DummyPass1!' }, false);
  await cust2.post('/api/auth/verify', { identifier: 'scan@example.com', code: r.json.dev_code }, false);
  await loginOtp(cust2, 'scan@example.com', 'DummyPass1!');
  r = await cust2.post('/api/reviews', { vendor_id: 2, food: 1, hygiene: 1, value: 1, overall: 1, comment: 'This place is bakwas and I will kill the owner, terrible food.' });
  eq('abusive review = 201 flagged', r.status === 201 && r.json.status === 'flagged', true);
  ok('flag score >= 40', r.json.flag_score >= 40);
  r = await anon.get('/api/vendors/2');
  eq('flagged review excluded from ratings count', r.json.vendor.ratings.count, 0);

  console.log('\n== review flagging (visitor) ==');
  r = await anon.post(`/api/reviews/${reviewId}/flag`, { reason: 'test flag' });
  eq('visitor flag = 200', r.status, 200);
  r = await anon.get('/api/vendors/1');
  ok('flagged review no longer counts in ratings', r.json.vendor.ratings.count === 0);

  console.log('\n== authz: role gates ==');
  r = await anon.get('/api/manager/vendor');
  eq('anon manager route = 401', r.status, 401);
  r = await cust.get('/api/admin/reports');
  eq('customer admin route = 403', r.status, 403);
  r = await cust.get('/api/manager/vendor');
  eq('customer manager route = 403', r.status, 403);

  console.log('\n== admin login (OTP, env bootstrap) ==');
  const admin = new Client();
  r = await admin.post('/api/auth/login', { identifier: 'testadmin@example.com', password: 'TestAdmin1!' }, false);
  eq('admin login asks OTP (all roles)', r.json.otp_required, true);
  r = await admin.post('/api/auth/login-verify', { login_token: r.json.login_token, code: r.json.dev_code }, false);
  eq('admin login = 200 owner', r.status === 200 && r.json.user.role === 'owner', true);

  console.log('\n== change password revokes other sessions ==');
  const custA = new Client(), custB = new Client();
  await loginOtp(custA, 'testcust@example.com', 'DummyPass1!');
  await loginOtp(custB, 'testcust@example.com', 'DummyPass1!');
  r = await custA.get('/api/auth/me');
  ok('session A alive before change', !!r.json.user);
  r = await custB.get('/api/auth/me');
  ok('session B alive before change', !!r.json.user);
  r = await custA.post('/api/auth/change-password', { old_password: 'WrongOld1!', new_password: 'NewDummyPass2!' });
  eq('change password wrong old = 401', r.status, 401);
  r = await custA.post('/api/auth/change-password', { old_password: 'DummyPass1!', new_password: 'short' });
  eq('change password short new = 400', r.status, 400);
  r = await custA.post('/api/auth/change-password', { old_password: 'DummyPass1!', new_password: 'NewDummyPass2!' });
  eq('change password = 200', r.status, 200);
  r = await custA.get('/api/auth/me');
  ok('own session survives password change', !!r.json.user);
  r = await custB.get('/api/auth/me');
  ok('other session revoked after password change', r.json.user === null);
  r = await custA.post('/api/auth/login', { identifier: 'testcust@example.com', password: 'NewDummyPass2!' }, false);
  eq('login with new password asks OTP', r.json.otp_required, true);
  r = await custA.post('/api/auth/login-verify', { login_token: r.json.login_token, code: r.json.dev_code }, false);
  eq('login with new password works', r.status, 200);

  console.log('\n== manager: admin creates manager, setup, OTP login ==');
  // Public manager signup is closed (410) — the admin creates managers.
  const mgrProbe = new Client();
  r = await mgrProbe.post('/api/auth/register-manager', { name: 'Sneaky Manager', email: 'sneaky@example.com', password: 'DummyPass1!' }, false);
  eq('public manager register = 410', r.status, 410);
  const mgr = await makeManager(admin, 'Test Manager', 'testmgr@example.com');
  // OTP wrong-code + resend behaviour on a fresh login attempt:
  r = await mgr.post('/api/auth/login', { identifier: 'testmgr@example.com', password: 'DummyPass1!' }, false);
  eq('manager login asks OTP', r.status === 200 && r.json.otp_required === true && typeof r.json.dev_code === 'string', true);
  const firstCode = r.json.dev_code, firstToken = r.json.login_token;
  r = await mgr.post('/api/auth/login-verify', { login_token: firstToken, code: '000000' }, false);
  eq('manager OTP wrong code = 400', r.status, 400);
  r = await mgr.post('/api/auth/login-resend', { login_token: firstToken }, false);
  const newCode = r.json.dev_code;
  eq('login resend = 200 with a different code', r.status === 200 && typeof newCode === 'string' && newCode !== firstCode, true);
  r = await mgr.post('/api/auth/login-verify', { login_token: firstToken, code: firstCode }, false);
  eq('old code after resend = 400', r.status, 400);
  r = await mgr.post('/api/auth/login-verify', { login_token: firstToken, code: newCode }, false);
  eq('new code after resend = 200 role manager', r.status === 200 && r.json.user.role === 'manager', true);
  r = await mgr.get('/api/manager/vendor');
  eq('new manager has no vendor', r.json.vendor, null);
  r = await mgr.post('/api/manager/vendors', { name: 'Test Biryani House', category: 'NotACategory', city: 'Peshawar' });
  eq('vendor bad category = 400', r.status, 400);
  r = await mgr.post('/api/manager/vendors', { name: 'Test Biryani House', category: 'Desi', city: 'Peshawar', area: 'Hayatabad', delivery_enabled: true, delivery_fee_pkr: 100, min_order_pkr: 300 });
  eq('vendor submit = 201 pending', r.status === 201 && r.json.status === 'pending', true);
  const newVendorId = r.json.vendorId;
  r = await mgr.post('/api/manager/vendors', { name: 'Second Place', category: 'Desi', city: 'Lahore' });
  eq('second vendor per manager = 409', r.status, 409);
  r = await mgr.get('/api/manager/vendor');
  eq('manager sees own vendor', r.json.vendor && r.json.vendor.id === newVendorId, true);

  console.log('\n== manager: cross-vendor isolation ==');
  const mgr2 = await makeManager(admin, 'Second Manager', 'testmgr2@example.com');
  r = await mgr2.patch(`/api/manager/vendors/${newVendorId}`, { city: 'Karachi' });
  eq('manager B PATCH manager A vendor = 404', r.status, 404);
  r = await mgr2.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'TEST-1', vendor_id: newVendorId });
  eq('manager B payment attached to A vendor = 400/403', r.status === 400 || r.status === 403, true);
  r = await mgr2.post('/api/manager/certificates', { cert_type: 'Food Licence', vendor_id: newVendorId });
  eq('manager B certificate attached to A vendor = 400/403', r.status === 400 || r.status === 403, true);
  r = await mgr.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'TEST-OWN', vendor_id: newVendorId });
  eq('manager A payment on own vendor = 201 amount 1500', r.status === 201 && r.json.amount_pkr === 1500, true);
  const ownPaymentId = r.json.paymentId;
  r = await mgr.post('/api/manager/payments', { plan: 'Wrong', method: 'JazzCash', reference_text: 'x' });
  eq('payment bad plan = 400', r.status, 400);
  r = await mgr.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'x', proof_filename: 'p.png', proof_mimetype: 'image/png', proof_base64: Buffer.from('%PDF-fake').toString('base64') });
  eq('payment proof magic mismatch = 400', r.status, 400);
  r = await mgr.post('/api/manager/payments', { plan: 'Basic', method: 'JazzCash', reference_text: 'x', proof_filename: 'p.png', proof_mimetype: 'image/png', proof_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64') });
  eq('payment proof valid PNG magic = 201', r.status, 201);

  console.log('\n== manager: sensitive fields + menu validation ==');
  r = await mgr.patch(`/api/manager/vendors/${newVendorId}`, { name: 'Hacked Name' });
  eq('PATCH sensitive field name = 400', r.status, 400);
  r = await mgr.patch(`/api/manager/vendors/${newVendorId}`, { description: 'Updated description', delivery_fee_pkr: -50 });
  eq('PATCH negative delivery fee = 400', r.status, 400);
  r = await mgr.patch(`/api/manager/vendors/${newVendorId}`, { description: 'Updated description', open: true });
  eq('PATCH non-sensitive = 200', r.status, 200);
  r = await mgr.post('/api/manager/menu', { name: 'Chicken Biryani', price_pkr: -100 });
  eq('menu negative price = 400', r.status, 400);
  r = await mgr.post('/api/manager/menu', { name: 'Chicken Biryani', price_pkr: 320, category: 'Desi' });
  eq('menu add = 201', r.status, 201);
  const menuId = r.json.menuId;
  r = await mgr.patch(`/api/manager/menu/${menuId}`, { price_pkr: -5 });
  eq('menu PATCH negative price = 400', r.status, 400);
  r = await mgr.patch(`/api/manager/menu/${menuId}`, { price_pkr: 350 });
  eq('menu PATCH price = 200', r.status, 200);
  r = await mgr.del('/api/manager/menu/1');
  eq('manager DELETE other vendor menu = 404', r.status, 404);
  r = await mgr.del(`/api/manager/menu/${menuId}`);
  eq('menu DELETE = 200', r.status, 200);
  r = await mgr.get('/api/manager/vendor');
  eq('menu item gone after DELETE', r.json.vendor.menu.some((m) => m.id === menuId), false);
  r = await mgr.post('/api/manager/vendors/' + newVendorId + '/update-request', { name: 'Test Biryani House Updated' });
  eq('sensitive update request = 201', r.status, 201);
  r = await mgr.post('/api/manager/gallery', { url: 'https://example.com/photo.jpg', caption: 'test' });
  eq('gallery submit = 201 pending', r.status === 201 && r.json.status === 'pending', true);
  r = await mgr.post('/api/manager/staff', { name: 'Test Staff', email: 'teststaff@example.com', password: 'DummyPass1!' });
  eq('staff create = 201', r.status, 201);
  const staffId = r.json.staffId;

  console.log('\n== admin-managed managers: negative cases ==');
  r = await admin.post('/api/admin/managers', { name: 'Bad Email', email: 'not-an-email' });
  eq('admin create manager bad email = 400', r.status, 400);
  r = await admin.post('/api/admin/managers', { name: 'Dup', email: 'testmgr@example.com' });
  eq('admin create manager duplicate email = 409', r.status, 409);
  r = await mgr.post('/api/admin/managers', { name: 'Nope', email: 'nope@example.com' });
  eq('manager cannot create managers = 403', r.status, 403);
  r = await admin.post('/api/admin/managers', { name: 'Setup Test', email: 'setuptest@example.com' });
  eq('admin create manager for setup test = 201', r.status, 201);
  const setupCode = r.json.dev_code;
  const setupClient = new Client();
  r = await setupClient.post('/api/auth/manager-setup', { email: 'setuptest@example.com', code: '000000', password: 'DummyPass1!' }, false);
  eq('manager setup wrong code = 400', r.status, 400);
  r = await setupClient.post('/api/auth/manager-setup', { email: 'setuptest@example.com', code: setupCode, password: 'short' }, false);
  eq('manager setup short password = 400', r.status, 400);
  r = await setupClient.post('/api/auth/manager-setup', { email: 'setuptest@example.com', code: setupCode, password: 'DummyPass1!' }, false);
  eq('manager setup correct = 200', r.status, 200);
  r = await setupClient.post('/api/auth/manager-setup', { email: 'setuptest@example.com', code: setupCode, password: 'DummyPass1!' }, false);
  eq('manager setup twice = 400 already set up', r.status, 400);
  r = await setupClient.post('/api/auth/manager-setup', { email: 'nobody@example.com', code: '123456', password: 'DummyPass1!' }, false);
  eq('manager setup unknown email = 404', r.status, 404);

  console.log('\n== staff: assigned vendor only ==');
  const staff = new Client();
  await loginOtp(staff, 'teststaff@example.com', 'DummyPass1!');
  r = await staff.get('/api/staff/vendor');
  eq('staff sees assigned vendor', r.json.vendor && r.json.vendor.id === newVendorId, true);
  r = await staff.post('/api/staff/menu', { name: 'Staff Item', price_pkr: -10 });
  eq('staff menu negative price = 400', r.status, 400);
  r = await staff.post('/api/staff/menu', { name: 'Staff Item', price_pkr: 200 });
  eq('staff menu add = 201', r.status, 201);
  const staffMenuId = r.json.menuId;
  r = await staff.patch(`/api/staff/menu/${staffMenuId}`, { price_pkr: -1 });
  eq('staff menu PATCH negative = 400', r.status, 400);
  r = await staff.patch('/api/staff/menu/1', { price_pkr: 999 });
  eq('staff PATCH other vendor menu = 404', r.status, 404);
  r = await staff.del('/api/staff/menu/1');
  eq('staff DELETE other vendor menu = 404', r.status, 404);
  r = await staff.del(`/api/staff/menu/${staffMenuId}`);
  eq('staff menu DELETE = 200', r.status, 200);
  r = await staff.get('/api/staff/vendor');
  eq('staff menu item gone after DELETE', r.json.menu.some((m) => m.id === staffMenuId), false);
  r = await staff.get('/api/admin/reports');
  eq('staff admin route = 403', r.status, 403);

  console.log('\n== admin: approve flow end-to-end ==');
  r = await admin.get('/api/auth/me');
  eq('admin session still owner', r.json.user && r.json.user.role, 'owner');
  r = await admin.get('/api/admin/reports');
  eq('reports totals vendors_total = 8', r.json.totals.vendors_total, 8);
  ok('reports has top_by_rating + category_totals', Array.isArray(r.json.top_by_rating) && Array.isArray(r.json.category_totals));
  r = await admin.get('/api/admin/audit-log');
  ok('audit log non-empty', r.json.log.length > 0);
  r = await admin.get('/api/admin/vendors');
  eq('admin vendors list = 8', r.json.vendors.length, 8);
  r = await admin.post(`/api/admin/payments/${ownPaymentId}/approve`, {});
  eq('admin approve payment = 200', r.status, 200);
  r = await admin.post(`/api/admin/vendors/${newVendorId}/approve`, {});
  eq('admin approve vendor = 200', r.status, 200);
  r = await anon.get('/api/vendors');
  ok('newly approved+paid vendor now public', r.json.vendors.some((v) => v.id === newVendorId));
  eq('public vendors now 6', r.json.vendors.length, 6);
  r = await admin.post(`/api/admin/vendors/${newVendorId}/suspend`, {});
  eq('suspend without reason = 400', r.status, 400);
  r = await admin.post(`/api/admin/vendors/${newVendorId}/suspend`, { reason: 'test suspension' });
  eq('suspend with reason = 200', r.status, 200);
  r = await anon.get('/api/vendors');
  ok('suspended vendor hidden publicly', !r.json.vendors.some((v) => v.id === newVendorId));
  r = await admin.post(`/api/admin/vendors/${newVendorId}/unsuspend`, {});
  eq('unsuspend = 200', r.status, 200);
  r = await anon.get('/api/vendors');
  ok('unsuspended vendor public again', r.json.vendors.some((v) => v.id === newVendorId));
  r = await admin.post(`/api/admin/users/${staffId}/suspend`, {});
  eq('admin suspend staff user = 200', r.status, 200);
  r = await staff.get('/api/auth/me');
  ok('suspended staff session dead', r.json.user === null);
  r = await admin.post(`/api/admin/users/${staffId}/activate`, {});
  eq('admin activate staff user = 200', r.status, 200);
  r = await admin.post('/api/admin/users/1/suspend', {});
  eq('cannot suspend owner = 403', r.status, 403);
  r = await admin.get('/api/admin/activity');
  ok('activity endpoint returns rows', Array.isArray(r.json.activity));
  r = await admin.post(`/api/admin/reviews/${reviewId}/reply`, { reply: 'Thanks for visiting!' });
  eq('admin reply to review = 200', r.status, 200);
  r = await anon.get('/api/vendors/1');
  ok('admin reply visible on vendor detail', r.json.vendor.reviews.some((x) => x.admin_reply === 'Thanks for visiting!'));

  console.log('\n== rejected vendor resubmit + unsuspend of never-approved ==');
  r = await mgr2.post('/api/manager/vendors', { name: 'Second Manager Place', category: 'BBQ', city: 'Karachi' });
  eq('manager B vendor submit = 201', r.status, 201);
  const mgr2VendorId = r.json.vendorId;
  r = await admin.post(`/api/admin/vendors/${mgr2VendorId}/reject`, { reason: 'test rejection' });
  eq('admin reject vendor = 200', r.status, 200);
  r = await mgr2.post('/api/manager/vendors', { name: 'Second Manager Place v2', category: 'BBQ', city: 'Karachi' });
  eq('resubmit after rejection = 201 (not 409)', r.status, 201);
  r = await admin.post('/api/admin/vendors/6/suspend', { reason: 'test suspend of pending vendor' });
  eq('suspend pending vendor = 200', r.status, 200);
  r = await admin.post('/api/admin/vendors/6/unsuspend', {});
  eq('unsuspend never-approved vendor = 200', r.status, 200);
  r = await admin.get('/api/admin/vendors');
  ok('unsuspended never-approved vendor back to pending, not approved',
    r.json.vendors.find((v) => v.id === 6).status === 'pending');
  r = await anon.get('/api/vendors');
  ok('never-approved vendor still not public after unsuspend', !r.json.vendors.some((v) => v.id === 6));

  console.log('\n== admin-published plans ==');
  r = await mgr.get('/api/plans');
  eq('manager plans = 3 seeded', Object.keys(r.json.plans).length, 3);
  r = await admin.get('/api/admin/plans');
  eq('admin plans list = 3', r.json.plans.length, 3);
  r = await admin.post('/api/admin/plans', { name: 'Starter', days: 7, price_pkr: 500 });
  eq('admin create plan Starter = 201', r.status, 201);
  const starterId = r.json.planId;
  r = await admin.post('/api/admin/plans', { name: 'Starter', days: 7, price_pkr: 500 });
  eq('admin create duplicate plan = 409', r.status, 409);
  r = await admin.post('/api/admin/plans', { name: '', days: 7, price_pkr: 500 });
  eq('admin create plan empty name = 400', r.status, 400);
  r = await admin.post('/api/admin/plans', { name: 'Bad', days: 0, price_pkr: 500 });
  eq('admin create plan 0 days = 400', r.status, 400);
  r = await mgr.get('/api/plans');
  eq('manager plans now 4 incl Starter', Object.keys(r.json.plans).length, 4);
  eq('Starter public price 500/7d', r.json.plans.Starter, { days: 7, price: 500 });
  r = await admin.patch('/api/admin/plans/' + starterId, { published: false });
  eq('admin unpublish Starter = 200', r.status, 200);
  r = await mgr.get('/api/plans');
  ok('unpublished Starter hidden publicly', !r.json.plans.Starter);
  r = await mgr.post('/api/manager/payments', { plan: 'Starter', method: 'JazzCash', reference_text: 'PLAN-TEST' });
  eq('payment with unpublished plan = 400', r.status, 400);
  r = await admin.patch('/api/admin/plans/' + starterId, { published: true });
  eq('admin republish Starter = 200', r.status, 200);
  r = await mgr.post('/api/manager/payments', { plan: 'Starter', method: 'JazzCash', reference_text: 'PLAN-TEST-2' });
  eq('payment with republished Starter = 201 amount 500', r.status === 201 && r.json.amount_pkr === 500, true);
  r = await admin.patch('/api/admin/plans/' + starterId, { price_pkr: 600 });
  eq('admin change Starter price = 200', r.status, 200);
  r = await mgr.post('/api/manager/payments', { plan: 'Starter', method: 'JazzCash', reference_text: 'PLAN-TEST-3' });
  eq('payment uses new Starter price 600', r.status === 201 && r.json.amount_pkr === 600, true);
  r = await admin.patch('/api/admin/plans/9999', { price_pkr: 1 });
  eq('admin PATCH unknown plan = 404', r.status, 404);
  r = await admin.patch('/api/admin/plans/' + starterId, { days: 0 });
  eq('admin PATCH plan 0 days = 400', r.status, 400);

  console.log('\n== flag rate limit ==');
  for (let i = 0; i < 4; i++) await anon.post(`/api/reviews/${reviewId}/flag`, { reason: 'rate test ' + i });
  r = await anon.post(`/api/reviews/${reviewId}/flag`, { reason: '6th flag in 30 min' });
  eq('6th flag within 30 min = 429', r.status, 429);

  console.log('\n== research features: hours, saved, reports, halal, review photo ==');
  // biryani seed dish (QA found no biryani anywhere in the seed menus)
  r = await anon.get('/api/vendors/3');
  ok('vendor 3 menu has Chicken Biryani (Full) PKR 350', r.json.vendor.menu.some((m) => m.name === 'Chicken Biryani (Full)' && m.price_pkr === 350));
  // hours (seeded 11:00-23:00 daily)
  r = await anon.get('/api/vendors/1');
  eq('vendor 1 detail has 7 hours rows', r.json.vendor.hours.length, 7);
  ok('vendor 1 detail has open_now boolean', typeof r.json.vendor.open_now === 'boolean');
  ok('vendor 1 detail has halal + payment fields', r.json.vendor.halal_verified === true && r.json.vendor.payment_methods.includes('Cash on Delivery'));
  ok('vendor 1 detail has certificates + menu freshness', Array.isArray(r.json.vendor.certificates) && typeof r.json.vendor.menu_last_updated === 'string');
  // manager hours — vendor 1 is assigned to a freshly created manager
  const mgrSeed = await makeManager(admin, 'Assigned Manager', 'assigned@example.com');
  r = await admin.post('/api/admin/vendors/1/assign', { manager_email: 'assigned@example.com' });
  eq('admin assigns vendor 1 to manager = 200', r.status, 200);
  r = await mgrSeed.get('/api/manager/vendor');
  eq('assigned manager sees vendor 1', r.json.vendor && r.json.vendor.id === 1, true);
  r = await mgrSeed.post('/api/manager/vendors/1/hours', { hours: [{day:0,closed:true},{day:1,open:'10:00',close:'22:00'}] });
  eq('manager set hours = 200', r.status, 200);
  eq('hours saved back', r.json.hours.find((h)=>h.day===0).closed, true);
  r = await mgrSeed.post('/api/manager/vendors/1/hours', { hours: [{day:1,open:'22:00',close:'10:00'}] });
  eq('hours close before open = 400', r.status, 400);
  // halal + payment methods via manager PATCH
  r = await mgrSeed.patch('/api/manager/vendors/1', { payment_methods: 'Cash on Delivery, JazzCash' });
  eq('manager PATCH payment methods = 200', r.status, 200);
  r = await mgrSeed.patch('/api/manager/vendors/1', { payment_methods: 'Bitcoin' });
  eq('manager PATCH bad payment method = 400', r.status, 400);
  r = await admin.post('/api/admin/vendors/1/verify-halal', {});
  eq('admin verify halal = 200', r.status, 200);
  r = await anon.get('/api/vendors/1');
  ok('vendor 1 halal verified + JazzCash after PATCH', r.json.vendor.halal_verified === true && r.json.vendor.payment_methods.includes('JazzCash'));
  // saved (fresh customer)
  const cust3 = new Client();
  r = await cust3.post('/api/auth/register-customer', { name: 'Save Test', email: 'save@example.com', password: 'DummyPass1!' }, false);
  await cust3.post('/api/auth/verify', { identifier: 'save@example.com', code: r.json.dev_code }, false);
  await loginOtp(cust3, 'save@example.com', 'DummyPass1!');
  r = await anon.post('/api/saved/1', {}, true);
  eq('anon save = 401', r.status, 401);
  r = await cust3.post('/api/saved/1', {});
  eq('customer save vendor 1 = 200 saved true', r.status === 200 && r.json.saved === true, true);
  r = await cust3.get('/api/saved');
  eq('saved list has vendor 1', r.json.vendors.map((v)=>v.id), [1]);
  r = await cust3.post('/api/saved/1', {});
  eq('customer unsave = 200 saved false', r.json.saved, false);
  r = await cust3.get('/api/saved');
  eq('saved list empty after unsave', r.json.vendors.length, 0);
  r = await cust3.post('/api/saved/6', {});
  eq('save non-public vendor = 404', r.status, 404);
  // listing reports
  r = await anon.post('/api/reports', { vendor_id: 1, type: 'wrong_phone', message: 'test report: phone number is wrong' });
  eq('anon report = 201', r.status, 201);
  const reportId = r.json.reportId;
  r = await anon.post('/api/reports', { vendor_id: 1, type: 'wrong_phone', message: 'bad' });
  eq('report short message = 400', r.status, 400);
  r = await anon.post('/api/reports', { vendor_id: 1, type: 'nope', message: 'test report bad type here' });
  eq('report bad type = 400', r.status, 400);
  r = await anon.post('/api/reports', { vendor_id: 1, menu_item_id: 1, type: 'wrong_price', message: 'test report: counter charges more' });
  eq('report wrong price on menu item = 201', r.status, 201);
  r = await admin.get('/api/admin/listing-reports');
  ok('admin sees pending report', r.json.reports.some((x)=>x.id===reportId && x.status==='pending'));
  r = await admin.post(`/api/admin/listing-reports/${reportId}/resolve`, {});
  eq('admin resolve report = 200', r.status, 200);
  r = await admin.get('/api/admin/reports');
  ok('admin reports has stale_menus array + reports pending count', Array.isArray(r.json.stale_menus) && typeof r.json.totals.listing_reports_pending === 'number');
  // review photo
  r = await cust3.post('/api/reviews', { vendor_id: 2, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'Great nihari with a photo attached for this test.', photo_url: 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800' });
  eq('review with photo = 201', r.status, 201);
  r = await anon.get('/api/vendors/2');
  ok('review photo visible on vendor detail', r.json.vendor.reviews.some((x)=>x.photo_url && x.photo_url.includes('unsplash')));
  r = await cust3.post('/api/reviews', { vendor_id: 3, food: 5, hygiene: 5, value: 5, overall: 5, comment: 'Another review with a bad photo link here.', photo_url: 'ftp://example.com/x.jpg' });
  eq('review bad photo url = 400', r.status, 400);
  // menu edit touches updated_at + price changes
  r = await mgrSeed.patch('/api/manager/menu/1', { price_pkr: 460 });
  eq('manager menu price edit = 200', r.status, 200);
  r = await anon.get('/api/vendors/1');
  ok('menu price updated to 460 + freshness present', r.json.vendor.menu.find((m)=>m.id===1).price_pkr===460 && typeof r.json.vendor.menu_last_updated === 'string');

  console.log('\n== clean seed: no demo accounts ==');
  const ghost = new Client();
  r = await ghost.post('/api/auth/login', { identifier: 'mhkh3200@gmail.com', password: '38fSK9yuWq6fRZwtk8szvvXp' }, false);
  eq('old seeded admin login = 401', r.status, 401);
  r = await ghost.post('/api/auth/login', { identifier: 'chapli.house.peshawar@gmail.com', password: 'B864OQbtyWcSvUqQtB7d5ito' }, false);
  eq('old seeded manager login = 401', r.status, 401);
  r = await ghost.post('/api/auth/login', { identifier: 'ahmed.raza.khi@gmail.com', password: '3hadIEWZ+EbSsnC4mOLa9G+z' }, false);
  eq('old seeded customer login = 401', r.status, 401);
  r = await admin.get('/api/admin/users');
  ok('users are only test-created accounts (no demo names)',
    r.json.users.every((u) => !['mhkh3200@gmail.com', 'chapli.house.peshawar@gmail.com', 'ahmed.raza.khi@gmail.com'].includes(u.email)));

  console.log('\n== admin assign / unassign + isolation ==');
  const mgrX = await makeManager(admin, 'Manager X', 'mgrx@example.com');
  r = await mgr.post('/api/admin/vendors/2/assign', { manager_email: 'mgrx@example.com' });
  eq('manager cannot assign = 403', r.status, 403);
  r = await admin.post('/api/admin/vendors/2/assign', { manager_email: 'nobody@example.com' });
  eq('assign unknown email = 404', r.status, 404);
  r = await admin.post('/api/admin/vendors/2/assign', { manager_email: 'testcust@example.com' });
  eq('assign to a customer = 400', r.status, 400);
  r = await admin.post('/api/admin/vendors/1/assign', { manager_email: 'mgrx@example.com' });
  eq('assign already-assigned vendor = 409', r.status, 409);
  r = await admin.post('/api/admin/vendors/2/assign', { manager_email: 'assigned@example.com' });
  eq('assign second vendor to same manager = 409', r.status, 409);
  r = await mgrSeed.post('/api/manager/vendors/2/hours', { hours: [{ day: 0, open: '09:00', close: '21:00' }] });
  eq('manager hours on another manager vendor = 404', r.status, 404);
  r = await mgrSeed.get('/api/manager/vendor');
  eq('manager still sees only own vendor 1', r.json.vendor && r.json.vendor.id === 1, true);
  r = await admin.post('/api/admin/vendors/1/unassign', {});
  eq('admin unassign = 200', r.status, 200);
  r = await mgrSeed.get('/api/manager/vendor');
  eq('manager vendor null after unassign', r.json.vendor, null);
  r = await admin.get('/api/admin/vendors');
  ok('admin vendors list still shows unclaimed vendor 1',
    r.json.vendors.some((v) => v.id === 1 && !v.manager_id));
  r = await admin.post('/api/admin/vendors/1/assign', { manager_email: 'assigned@example.com' });
  eq('re-assign after unassign = 200', r.status, 200);

  console.log('\n== static assets ==');
  r = await fetch(BASE + '/app.js');
  ok('app.js 200', r.status === 200);
  r = await fetch(BASE + '/styles.css');
  ok('styles.css 200', r.status === 200);
  r = await fetch(BASE + '/nope.js');
  eq('unknown static = 404', r.status, 404);
  r = await fetch(BASE + '/api/nope');
  eq('unknown api = 404', r.status, 404);
}

main().catch((e) => { console.error('SUITE CRASH:', e); process.exit(1); });
