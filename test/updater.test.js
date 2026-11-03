// Automatic updates: served from a fake GitHub that hands out a tarball of
// this repository with a higher version number.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const updater = require('../server/updater');

const ROOT = path.join(__dirname, '..');

function fakeGitHub(version, { brokenServer = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-gh-'));
  const top = path.join(tmp, 'coaching-hub-local-main');
  fs.mkdirSync(top);
  for (const item of ['server', 'public', 'README.md']) fs.cpSync(path.join(ROOT, item), path.join(top, item), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(top, 'public', 'new-file.txt'), 'from the update');
  if (brokenServer) fs.writeFileSync(path.join(top, 'server', 'broken.js'), 'function (');
  execFileSync('tar', ['-czf', path.join(tmp, 'src.tgz'), '-C', tmp, 'coaching-hub-local-main']);
  const tgz = fs.readFileSync(path.join(tmp, 'src.tgz'));
  fs.rmSync(tmp, { recursive: true, force: true });
  return async (url) => {
    if (url.endsWith('/package.json')) return { ok: true, status: 200, text: async () => JSON.stringify(pkg) };
    if (url.includes('codeload.github.com')) return { ok: true, status: 200, arrayBuffer: async () => tgz };
    return { ok: false, status: 404 };
  };
}

function fakeBundle() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-bundle-'));
  const appDir = path.join(base, 'Coaching Hub.app', 'Contents', 'Resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of ['server', 'public', 'package.json']) fs.cpSync(path.join(ROOT, item), path.join(appDir, item), { recursive: true });
  return { base, appDir };
}

test('version comparison', () => {
  assert.ok(updater.newer('1.4.1', '1.4.0'));
  assert.ok(updater.newer('1.10.0', '1.9.9'));
  assert.ok(!updater.newer('1.4.0', '1.4.0'));
  assert.ok(!updater.newer('1.3.9', '1.4.0'));
  assert.ok(updater.inAppBundle('/Applications/Coaching Hub.app/Contents/Resources/app'));
  assert.ok(!updater.inAppBundle(ROOT));
});

test('checks, downloads, verifies and swaps in a newer version', async () => {
  const { base, appDir } = fakeBundle();
  const fetchImpl = fakeGitHub('9.0.0');
  const r = await updater.check({ appDir, fetchImpl });
  assert.equal(r.available, true);
  assert.equal(r.latest, '9.0.0');
  const v = await updater.install({ appDir, fetchImpl, expect: '9.0.0' });
  assert.equal(v, '9.0.0');
  assert.equal(updater.localVersion(appDir), '9.0.0');
  assert.equal(fs.readFileSync(path.join(appDir, 'public', 'new-file.txt'), 'utf8'), 'from the update');
  assert.ok(!fs.existsSync(appDir + '.old') && !fs.existsSync(appDir + '.new'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('a broken download leaves the current app untouched', async () => {
  const { base, appDir } = fakeBundle();
  const before = updater.localVersion(appDir);
  await assert.rejects(updater.install({ appDir, fetchImpl: fakeGitHub('9.0.0', { brokenServer: true }) }));
  assert.equal(updater.localVersion(appDir), before);
  await assert.rejects(updater.check({ appDir, fetchImpl: async () => ({ ok: false, status: 404 }) }), /public/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a server notices when its app files are replaced while it runs', async () => {
  const { createApp } = require('../server/app');
  const { base, appDir } = fakeBundle();
  const dataDir = fs.mkdtempSync(path.join(base, 'data-'));
  let restarted = 0;
  const app = createApp({ dataDir, localDir: dataDir, appDir, watchMs: 0, onRestart: () => { restarted++; } });
  try {
    assert.equal(app.codeChanged(), false);
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    const running = pkg.version;
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ ...pkg, version: '9.9.9' }));
    assert.equal(app.codeChanged(), true);
    const r = await app.autoUpdate();
    assert.equal(r.restarting, true);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(restarted, 1);
    assert.equal(running, pkg.version);
  } finally {
    app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
