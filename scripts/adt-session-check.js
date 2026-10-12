#!/usr/bin/env node
// Is the SAP system able to keep an ADT stateful session alive right now?
//
//   node scripts/adt-session-check.js /sap/bc/adt/oo/classes/zcl_my_class
//
// Replays what every write does, with a bare HTTP client (no MCP server, no project code):
//   LOCK (stateful) -> follow-up GET of the source (stateful) -> UNLOCK (stateless)
// and prints the status of each step. On a healthy system all three are 200. When a
// follow-up answers "400 Session not found", the system lost the session it just created:
// every write fails the same way and leaves an edit lock, whatever the code does. Seen on
// the development system; it comes and goes by itself. Wait or ask Basis (SM04/SM21), and
// do not run writes or the test suite meanwhile.
//
// Side effect when the system is faulty: the LOCK stays behind. Clear it with
// `UnlockObject object_name=... force=true` (or SM12). Use an object of your own.
// Credentials come from .env (SAP_URL, SAP_USERNAME, SAP_PASSWORD, SAP_CLIENT); never printed.
const path = require('path');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const axios = require('axios');
const https = require('https');

const objectUrl = process.argv[2];
if (!objectUrl || !objectUrl.startsWith('/sap/bc/adt/')) {
  console.error('usage: node scripts/adt-session-check.js /sap/bc/adt/<programs/programs|oo/classes>/<name>');
  process.exit(2);
}
for (const k of ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'SAP_CLIENT']) {
  if (!process.env[k]) { console.error(`missing ${k} in .env`); process.exit(2); }
}

const http = axios.create({
  baseURL: process.env.SAP_URL.replace(/\/$/, ''),
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  validateStatus: () => true,
  auth: { username: process.env.SAP_USERNAME, password: process.env.SAP_PASSWORD },
  headers: { 'sap-client': process.env.SAP_CLIENT },
});
const jar = new Map();
const remember = (r) => (r.headers['set-cookie'] || []).forEach((c) => {
  const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1));
});
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const brief = (r) => String(r.data).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);

(async () => {
  const t = await http.get('/sap/bc/adt/discovery', { headers: { 'x-csrf-token': 'fetch', Accept: 'application/atomsvc+xml' } });
  remember(t);
  const token = t.headers['x-csrf-token'];
  const lock = await http.post(`${objectUrl}?_action=LOCK&accessMode=MODIFY`, '', { headers: {
    'x-csrf-token': token, 'X-sap-adt-sessiontype': 'stateful', Cookie: cookie(),
    Accept: 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9' } });
  remember(lock);
  const handle = String(lock.data).match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  console.log(`1 LOCK      HTTP ${lock.status} ${handle ? '(lock handle received)' : '(no handle) ' + brief(lock)}`);
  if (!handle) { console.log('Cannot test: the lock was refused. Another session holds it, or the object does not exist.'); process.exit(1); }
  const get = await http.get(`${objectUrl}/source/main`, { headers: { 'X-sap-adt-sessiontype': 'stateful', Cookie: cookie(), Accept: 'text/plain' } });
  remember(get);
  console.log(`2 follow-up HTTP ${get.status} ${get.status >= 400 ? brief(get) : ''}`);
  const unlock = await http.post(`${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle[1])}`, '', { headers: {
    'x-csrf-token': token, 'X-sap-adt-sessiontype': 'stateless', Cookie: cookie() } });
  console.log(`3 UNLOCK    HTTP ${unlock.status} ${unlock.status >= 400 ? brief(unlock) : ''}`);
  const healthy = get.status === 200 && unlock.status === 200;
  console.log(healthy
    ? 'HEALTHY: the system kept the stateful session alive.'
    : 'FAULT: the system lost the session it just created. The lock is still held; clear it with UnlockObject force=true (or SM12). Do not run writes or tests until this passes.');
  process.exit(healthy ? 0 : 1);
})().catch((e) => { console.error('check failed:', e.message); process.exit(2); });
