#!/usr/bin/env node
// Starts Coaching Hub on http://localhost:4747 and opens it in the browser.
// If it is already running, just opens the browser.
const http = require('node:http');
const { execFile } = require('node:child_process');
const { createApp } = require('./app');
const { defaultDataDir } = require('./db');
const { resolveDataDir } = require('./location');

const PORT = Number(process.env.PORT) || 4747;
const URL = `http://localhost:${PORT}/`;
const openBrowser = !process.argv.includes('--no-open');

// On a Mac, open Coaching Hub in its own window with no address bar or tabs,
// using Chrome's app mode (or Edge or Brave). Falls back to the default
// browser if none of those is installed.
const APP_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
function appWindowBrowser() {
  if (process.platform !== 'darwin' || process.env.COACHING_HUB_WINDOW === 'browser') return null;
  const os = require('node:os');
  const fs = require('node:fs');
  for (const name of APP_BROWSERS) {
    for (const dir of ['/Applications', `${os.homedir()}/Applications`]) {
      const bin = `${dir}/${name}.app/Contents/MacOS/${name}`;
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

function open() {
  if (!openBrowser) return;
  const bin = appWindowBrowser();
  if (bin) {
    const { spawn } = require('node:child_process');
    const child = spawn(bin, [`--app=${URL}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' });
    child.on('error', () => execFile('open', [URL], () => {}));
    child.unref();
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [URL], () => {});
}

function alreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/location', headers: { host: 'localhost' }, timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  if (await alreadyRunning()) {
    console.log(`Coaching Hub is already running at ${URL}`);
    open();
    return;
  }
  const localDir = defaultDataDir();
  const dataDir = resolveDataDir(localDir);
  let app;
  const stop = () => { if (app) app.close(); process.exit(0); };
  // Under the login item, exiting with an error code makes launchd start the
  // (updated) server again straight away.
  const underLaunchd = process.env.XPC_SERVICE_NAME === 'local.coaching-hub';
  const restart = () => { if (app) app.close(); process.exit(75); };
  app = createApp({ dataDir, localDir, port: PORT, onQuit: stop, onRestart: underLaunchd ? restart : undefined });
  app.server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Coaching Hub is running at ${URL}`);
    console.log(`Data folder: ${dataDir}`);
    console.log('Keep this window open while you use the app. Close it (or press Ctrl+C) to stop.');
    open();
    const run = async () => {
      try {
        const b = await app.autoBackup();
        if (b) console.log(`Daily backup saved: ${b.name}${b.copiedTo ? ` (copy: ${b.copiedTo})` : ''}`);
      } catch (e) {
        console.error('Automatic backup failed:', e.message);
      }
    };
    const sync = () => app.googleSync('hourly').catch((e) => console.error('Google Calendar sync failed:', e.message));
    run();
    sync();
    const update = () => app.autoUpdate().then((r) => r && r.installed && console.log(`Updated to ${r.version}`)).catch((e) => console.error('Update check failed:', e.message));
    setTimeout(update, 60 * 1000).unref();
    setInterval(() => { run(); sync(); update(); }, 3600 * 1000).unref();
    // The app was reinstalled while this server was running: restart into the new code.
    if (underLaunchd) setInterval(() => { if (app.codeChanged()) { console.log('New app files found, restarting'); restart(); } }, 60 * 1000).unref();
  });
  app.server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use by another program. Set PORT=4748 and try again.` : e.message);
    process.exit(1);
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
