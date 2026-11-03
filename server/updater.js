'use strict';
// Automatic app updates from Jack's GitHub repository.
//
// Once a day the app reads package.json on the repository's main branch. If
// its version is newer than the running one, it downloads that branch,
// checks it, and swaps in the new server and screens. Only the app code is
// replaced: the data folder, backups and the bundled Node.js are untouched.
// The server then restarts itself (the login item starts it again).
//
// Updates are only installed when the app runs from "Coaching Hub.app", so a
// developer checkout is never overwritten.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const APP_DIR = path.join(__dirname, '..');
const DEFAULT_REPO = 'jacksteadd-code/coaching-hub-local';

function localVersion(appDir = APP_DIR) {
  return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function inAppBundle(appDir = APP_DIR) {
  return /\.app\/Contents\/Resources\/app\/?$/.test(appDir);
}

async function get(url, fetchImpl, asBuffer) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(120000), headers: { 'user-agent': 'coaching-hub-updater' } });
  } catch (e) {
    throw new Error(`Couldn't reach GitHub (${e.cause?.code || e.message})`);
  }
  if (res.status === 404) throw new Error('Update source not found. Is the GitHub repository public?');
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

async function check({ repo = DEFAULT_REPO, branch = 'main', appDir = APP_DIR, fetchImpl = fetch } = {}) {
  const pkg = JSON.parse(await get(`https://raw.githubusercontent.com/${repo}/${branch}/package.json`, fetchImpl));
  const current = localVersion(appDir);
  return { current, latest: pkg.version, available: newer(pkg.version, current) };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000 }, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out))));
}

// Download, verify and swap in the new version. Returns the installed version.
async function install({ repo = DEFAULT_REPO, branch = 'main', appDir = APP_DIR, fetchImpl = fetch, nodeBin = process.execPath, expect } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-hub-update-'));
  try {
    const tgz = path.join(work, 'src.tar.gz');
    fs.writeFileSync(tgz, await get(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`, fetchImpl, true));
    const x = path.join(work, 'x');
    fs.mkdirSync(x);
    await run('tar', ['-xzf', tgz, '-C', x]);
    const top = fs.readdirSync(x).map((d) => path.join(x, d)).find((d) => fs.existsSync(path.join(d, 'package.json')));
    if (!top) throw new Error('The download did not contain the app');
    for (const f of ['server/index.js', 'server/app.js', 'public/index.html', 'public/app.js']) {
      if (!fs.existsSync(path.join(top, f))) throw new Error(`The download is missing ${f}`);
    }
    const version = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).version;
    if (expect && version !== expect) throw new Error(`Expected version ${expect} but downloaded ${version}`);
    for (const f of fs.readdirSync(path.join(top, 'server')).filter((n) => n.endsWith('.js'))) await run(nodeBin, ['--check', path.join(top, 'server', f)]);

    // Stage next to the current app, then swap in two renames.
    const staged = appDir.replace(/\/?$/, '') + '.new';
    const old = appDir.replace(/\/?$/, '') + '.old';
    fs.rmSync(staged, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    for (const item of ['server', 'public', 'package.json', 'README.md']) {
      if (fs.existsSync(path.join(top, item))) fs.cpSync(path.join(top, item), path.join(staged, item), { recursive: true });
    }
    fs.renameSync(appDir, old);
    try {
      fs.renameSync(staged, appDir);
    } catch (e) {
      fs.renameSync(old, appDir);
      throw e;
    }
    fs.rmSync(old, { recursive: true, force: true });
    return version;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { DEFAULT_REPO, APP_DIR, localVersion, newer, inAppBundle, check, install };
