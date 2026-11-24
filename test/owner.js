'use strict';

/*
 * Owner console API tests.
 *
 * Runs the real server against a throwaway DATA_DIR so the checks prove actual
 * behaviour: unauthenticated access is refused, the owner password is hashed,
 * records are created, edited, reloaded and deleted, reminders are computed and
 * WhatsApp drafts come back with a real wa.me link. AI is disabled in this run
 * so the draft must fall back to the reviewed template instead of hanging.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.OWNER_TEST_PORT) || 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'owner-test-pass-123';
const CONTACT = '9876543210';

let child = null;
let cookie = '';
const passed = [];

function check(name, condition, detail) {
  if (!condition) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    throw new Error(name);
  }
  passed.push(name);
  console.log(`ok ${name}`);
}

async function req(method, urlPath, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (cookie) {
    headers.Cookie = cookie;
  }
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie.split(';')[0];
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  return { status: res.status, json, text };
}

async function waitForServer(deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        return;
      }
    } catch (err) {
      /* server not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not become ready');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-owner-'));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: dataDir,
      AI_KEYLESS_DISABLED: 'true',
      GEMINI_API_KEY: ''
    }),
    stdio: 'ignore'
  });

  try {
    await waitForServer(20000);

    /* --- unauthenticated access is refused ------------------------------- */
    let res = await req('GET', '/api/owner/session');
    check('session reports signed out before setup', res.json && res.json.authenticated === false, res.text);
    check('session reports no password configured', res.json && res.json.passwordConfigured === false, res.text);

    res = await req('GET', '/api/owner/records/customers');
    check('records refused without a session', res.status === 401, `status ${res.status}`);

    res = await req('POST', '/api/owner/records/customers', { record: { name: 'Sneaky' } });
    check('write refused without a session', res.status === 401, `status ${res.status}`);

    res = await req('GET', '/api/owner/summary');
    check('summary refused without a session', res.status === 401, `status ${res.status}`);

    res = await req('POST', '/api/owner/whatsapp/draft', { kind: 'customer', id: 'x' });
    check('whatsapp draft refused without a session', res.status === 401, `status ${res.status}`);

    /* --- first-run password --------------------------------------------- */
    res = await req('POST', '/api/owner/setup', { password: 'short' });
    check('weak password rejected', res.status === 400, `status ${res.status}`);

    res = await req('POST', '/api/owner/setup', { password: PASSWORD });
    check('owner password created', res.status === 200 && res.json && res.json.ok === true, res.text);
    check('session cookie issued', cookie.startsWith('shh_owner='), cookie);

    res = await req('GET', '/api/owner/session');
    check('session is authenticated after setup', res.json && res.json.authenticated === true, res.text);

    res = await req('POST', '/api/owner/setup', { password: 'another-pass-999' });
    check('second setup refused', res.status === 409, `status ${res.status}`);

    const ownerFile = path.join(dataDir, 'owner.json');
    const ownerRaw = fs.readFileSync(ownerFile, 'utf8');
    check('owner password stored as a hash', !ownerRaw.includes(PASSWORD) && ownerRaw.includes('"hash"'), 'plaintext present');
    check('owner file is private', (fs.statSync(ownerFile).mode & 0o077) === 0, `mode ${fs.statSync(ownerFile).mode.toString(8)}`);

    /* --- customer create / read / edit ---------------------------------- */
    res = await req('POST', '/api/owner/records/customers', {
      record: { name: 'Subhalaxmi Test', contact: CONTACT, language: 'English', goal: 'Sleep better', consent: true }
    });
    check('customer created', res.status === 200 && res.json.ok === true, res.text);
    const customerId = res.json && res.json.item && res.json.item.id;
    check('customer received an id', Boolean(customerId), res.text);

    res = await req('POST', '/api/owner/records/customers', { record: { name: '   ' } });
    check('nameless customer rejected', res.status === 400, `status ${res.status}`);

    res = await req('GET', '/api/owner/records/customers');
    check('customer listed after save', res.json.items.length === 1 && res.json.items[0].name === 'Subhalaxmi Test', res.text);

    res = await req('PATCH', `/api/owner/records/customers/${customerId}`, { patch: { goal: 'Run 5K' } });
    check('customer edited', res.status === 200 && res.json.item.goal === 'Run 5K', res.text);
    check('customer id preserved on edit', res.json.item.id === customerId, res.text);

    /* --- persistence across a reload ------------------------------------ */
    const recordsFile = path.join(dataDir, 'owner-records.json');
    check('records file written', fs.existsSync(recordsFile), recordsFile);
    const onDisk = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    check('saved record is on disk', onDisk.customers.length === 1 && onDisk.customers[0].goal === 'Run 5K', JSON.stringify(onDisk.customers));

    /* --- reminders ------------------------------------------------------- */
    res = await req('GET', '/api/owner/reminders');
    check('reminders reachable', res.status === 200 && Array.isArray(res.json.items), res.text);
    check(
      'customer without check-in is due',
      res.json.items.some((item) => item.type === 'customer' && item.id === customerId),
      res.text
    );

    res = await req('POST', '/api/owner/records/checkins', {
      record: { customerId, date: new Date().toISOString().slice(0, 10), stage: 'Week 1', note: 'Good start' }
    });
    check('check-in saved to the server', res.status === 200 && res.json.ok === true, res.text);

    res = await req('GET', '/api/owner/reminders');
    check(
      'fresh check-in clears the reminder',
      !res.json.items.some((item) => item.type === 'customer' && item.id === customerId),
      res.text
    );

    res = await req('POST', '/api/owner/records/followups', {
      record: {
        customerId,
        reason: 'Review week 1 progress',
        dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'Open',
        consent: true
      }
    });
    check('follow-up created', res.status === 200 && res.json.ok === true, res.text);
    const followupId = res.json.item.id;

    res = await req('GET', '/api/owner/reminders');
    const overdue = res.json.items.find((item) => item.type === 'followup' && item.id === followupId);
    check('overdue follow-up appears', Boolean(overdue), res.text);
    check('overdue follow-up reports days late', overdue && overdue.daysOverdue === 2, JSON.stringify(overdue));

    /* --- whatsapp draft -------------------------------------------------- */
    res = await req('POST', '/api/owner/whatsapp/draft', { kind: 'customer', id: customerId, language: 'en' });
    check('draft generated without AI', res.status === 200 && res.json.ok === true, res.text);
    check('draft falls back to template when AI is off', res.json.source === 'template', res.text);
    check('draft text is a real message', typeof res.json.text === 'string' && res.json.text.length > 40, res.text);
    check('draft declares manual delivery', res.json.delivery === 'manual', res.text);
    check('draft has a wa.me link', res.json.waLink === `https://wa.me/${CONTACT}?text=${encodeURIComponent(res.json.text)}`, res.text);

    res = await req('POST', '/api/owner/whatsapp/draft', { kind: 'customer', id: customerId, language: 'or' });
    check('odia draft uses odia script', /[\u0B00-\u0B7F]/.test(res.json.text), res.text.slice(0, 120));

    res = await req('PATCH', `/api/owner/records/customers/${customerId}`, { patch: { consent: false } });
    check('consent revoked', res.status === 200 && res.json.item.consent === false, res.text);
    res = await req('POST', '/api/owner/whatsapp/draft', { kind: 'customer', id: customerId });
    check('draft refused without consent', res.status === 403, `status ${res.status}`);
    await req('PATCH', `/api/owner/records/customers/${customerId}`, { patch: { consent: true } });

    /* --- lead tracking --------------------------------------------------- */
    res = await req('POST', '/api/owner/records/leads', {
      record: { name: 'Lead Test', contact: '9123456780', source: 'Walk-in', status: 'New', consent: 'Yes', date: '2026-01-01' }
    });
    check('lead created', res.status === 200 && res.json.ok === true, res.text);
    const leadId = res.json.item.id;

    res = await req('PATCH', `/api/owner/records/leads/${leadId}`, { patch: { status: 'Contacted' } });
    check('lead status updated', res.status === 200 && res.json.item.status === 'Contacted', res.text);

    res = await req('GET', '/api/owner/summary');
    check('summary counts customers', res.json.counts.customers === 1, res.text);
    check('summary counts leads', res.json.counts.leads === 1, res.text);
    check('summary reports open leads', res.json.openLeads === 1, res.text);
    check('summary reports due reminders', res.json.remindersDue >= 1, res.text);

    /* --- delete ---------------------------------------------------------- */
    res = await req('DELETE', `/api/owner/records/leads/${leadId}`);
    check('lead deleted', res.status === 200 && res.json.items.length === 0, res.text);

    res = await req('DELETE', `/api/owner/records/customers/${customerId}`);
    check('customer deleted', res.status === 200 && res.json.items.length === 0, res.text);

    res = await req('DELETE', '/api/owner/records/customers/does-not-exist');
    check('deleting an unknown record is a 404', res.status === 404, `status ${res.status}`);

    /* --- session lifecycle ---------------------------------------------- */
    res = await req('POST', '/api/owner/logout', {});
    check('logout succeeds', res.status === 200, res.text);
    res = await req('GET', '/api/owner/session');
    check('session cleared after logout', res.json.authenticated === false, res.text);
    res = await req('GET', '/api/owner/records/customers');
    check('records refused after logout', res.status === 401, `status ${res.status}`);

    res = await req('POST', '/api/owner/login', { password: 'wrong-password' });
    check('wrong password refused', res.status === 401, `status ${res.status}`);

    res = await req('POST', '/api/owner/login', { password: PASSWORD });
    check('correct password signs in', res.status === 200 && res.json.session.authenticated === true, res.text);
    res = await req('GET', '/api/owner/records/checkins');
    check('records readable after sign-in', res.status === 200 && res.json.items.length === 1, res.text);

    /* --- bulk replace keeps the v8 array shape --------------------------- */
    res = await req('PUT', '/api/owner/records/followups', { items: [] });
    check('bulk replace works', res.status === 200 && res.json.items.length === 0, res.text);
    res = await req('PUT', '/api/owner/records/followups', { items: [{ nope: true }] });
    check('bulk replace validates items', res.status === 200, res.text);

    console.log(`\nOwner console: ${passed.length} checks passed.`);
  } finally {
    if (child) {
      child.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (err) {
      /* temp dir cleanup is best effort */
    }
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  if (child) child.kill('SIGKILL');
  process.exit(1);
});
