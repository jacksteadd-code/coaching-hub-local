// Sharing data between two Macs through iCloud Drive, simulated with two app
// instances that have their own local folders and one shared "iCloud" folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const loc = require('../server/location');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-hub-loc-'));
const icloudHome = path.join(root, 'home');
fs.mkdirSync(loc.icloudRoot(icloudHome), { recursive: true });

async function mac(name) {
  const localDir = path.join(root, name);
  const app = createApp({ dataDir: loc.resolveDataDir(localDir), localDir, today: '2026-10-21', home: icloudHome, lockOptions: { id: name, name }, idleMs: 50 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const req = (method, url, body) => new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: `localhost:${port}`, 'x-coaching-hub': '1', ...(data ? { 'content-length': data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  return { app, req, localDir };
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('move to iCloud, use it from a second Mac, one at a time', async () => {
  const laptop = await mac('Laptop');
  await laptop.req('POST', '/api/athletes', { name: 'Shared Athlete' });
  let r = await laptop.req('POST', '/api/location/icloud', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shared, true);
  assert.equal(loc.readPointer(laptop.localDir), r.body.icloudDir);
  assert.ok(fs.existsSync(path.join(r.body.icloudDir, 'in-use.json')));

  // Second Mac: has its own local data, sees iCloud data, but the laptop is using it.
  const studio = await mac('Studio');
  r = await studio.req('POST', '/api/location/icloud', {});
  assert.equal(r.status, 409, 'asks before replacing');
  r = await studio.req('POST', '/api/location/icloud', { mode: 'use' });
  assert.equal(r.status, 423);
  assert.equal(r.body.busy.name, 'Laptop');

  // Laptop goes idle → lets go of the data.
  await new Promise((res) => setTimeout(res, 80));
  laptop.app.closeData();
  r = await studio.req('POST', '/api/location/icloud', { mode: 'use' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = (await studio.req('GET', '/api/athletes')).body;
  assert.deepEqual(list.map((a) => a.name), ['Shared Athlete']);

  // Now the laptop is the one that has to wait.
  r = await laptop.req('GET', '/api/athletes');
  assert.equal(r.status, 423);
  assert.equal(r.body.busy.name, 'Studio');
  r = await laptop.req('GET', '/api/location');
  assert.equal(r.body.busy.name, 'Studio');

  // "Open here anyway" takes over; the studio notices on its next heartbeat.
  r = await laptop.req('POST', '/api/location/open-anyway');
  assert.equal(r.body.open, true);
  assert.equal(studio.app.state.lock.beat(), false);

  // Move back to this Mac only.
  r = await laptop.req('POST', '/api/location/local');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shared, false);
  assert.equal(loc.readPointer(laptop.localDir), null);
  assert.deepEqual((await laptop.req('GET', '/api/athletes')).body.map((a) => a.name), ['Shared Athlete']);

  laptop.app.close();
  studio.app.close();
});

test('stale locks are ignored', () => {
  const dir = fs.mkdtempSync(path.join(root, 'stale-'));
  let t = Date.now();
  const a = new loc.Lock(dir, { id: 'a', name: 'A', now: () => t });
  const b = new loc.Lock(dir, { id: 'b', name: 'B', now: () => t });
  assert.ok(a.acquire().ok);
  assert.equal(b.acquire().ok, false);
  t += loc.STALE_MS + 1000;
  assert.ok(b.acquire().ok, 'a Mac that crashed or lost power does not lock the data forever');
});
