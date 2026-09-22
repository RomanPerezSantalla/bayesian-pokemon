/**
 * `npm run phone`: the app on your phone, over HTTPS so voice works, served from this PC.
 *
 * Builds a test copy of the app (rebuilt whenever a source file changes: reload the page on the
 * phone to get it), serves it, opens a free Cloudflare quick tunnel to it and prints a QR code to
 * scan. The test copy reports back what happens on the phone: .cache/phone-log.jsonl gets each
 * voice phrase (what was heard and what it did), undos and errors; .cache/phone-battles/ gets each
 * battle as it's saved. So a test can be gone through afterwards.
 *
 * The tunnel's address changes every run, and a phone keeps each address's data apart: keep this
 * running for a whole test session, or carry teams and battles over with a backup file.
 *
 *   npm run phone              build, serve and tunnel
 *   npm run phone -- --local   no tunnel: this PC only, at http://localhost:4180
 */
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import qrcode from 'qrcode-terminal';
import {build, preview} from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache');
const outDir = path.join(cache, 'phone-dist');
const logFile = path.join(cache, 'phone-log.jsonl');
const battleDir = path.join(cache, 'phone-battles');
const PORT = 4180;
/** A bug report with a long battle is ~100 KB. */
const MAX_BODY = 1 << 20;
const MAX_LOG = 50 << 20;
const CLOUDFLARED = 'cloudflared@0.7.3';
const localOnly = process.argv.includes('--local');
const win = process.platform === 'win32';
const rel = p => path.relative(root, p).replaceAll('\\', '/');

fs.mkdirSync(battleDir, {recursive: true});

// --- what the phone sends back (src/testlog.ts) ----------------------------------------------

const firstLine = s => String(s ?? '').split('\n')[0];

/** One line in this terminal for the things worth seeing live. */
function summary(e) {
  switch (e.kind) {
    case 'start': return `phone connected: ${e.screen ?? ''}${e.installed ? ', installed app' : ''}`;
    case 'voice': {
      // What it logged; the move still open (it's logged when the next one starts) ends in "…".
      const parts = [...(e.did ?? []), ...(e.draft ? [`${e.draft} …`] : [])];
      return `heard “${e.heard?.[0] ?? ''}” → ${e.events?.length ? parts.join(' · ') || 'nothing to log' : "didn't understand"}`;
    }
    case 'voice-discard': return `✕ threw away: ${e.draft}`;
    case 'voice-error': return `voice: ${e.error}`;
    case 'undo': return `↶ undid ${e.undid ?? 'the last entry'}${e.narrated ? ' (logged by voice)' : ''}`;
    case 'error':
    case 'crash': return `⚠ ${e.kind === 'crash' ? 'crash screen' : 'error'}: ${firstLine(e.report?.error ?? e.error)}`;
    default: return null;
  }
}

let logFull = false;
function record(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string') throw new Error('not a log entry');
  const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  if (size > MAX_LOG) {
    if (!logFull) console.log(`  (${rel(logFile)} is over ${MAX_LOG >> 20} MB: not writing more)`);
    logFull = true;
    return;
  }
  fs.appendFileSync(logFile, `${JSON.stringify({got: new Date().toISOString(), ...entry})}\n`);
  const line = summary(entry);
  if (line) console.log(`  ${new Date().toLocaleTimeString()}  ${line}`);
}

function saveBattle(b) {
  if (typeof b?.id !== 'string' || !/^[a-z0-9]{1,40}$/i.test(b.id) || !Array.isArray(b.events)) throw new Error('not a battle');
  fs.writeFileSync(path.join(battleDir, `${b.id}.json`), JSON.stringify(b));
}

function phoneLog() {
  return {
    name: 'phone-log',
    configurePreviewServer(server) {
      server.middlewares.use('/__log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size <= MAX_BODY) chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            if (size > MAX_BODY) throw Object.assign(new Error('too big'), {status: 413});
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (req.url?.startsWith('/battle')) saveBattle(body);
            else record(body);
            res.statusCode = 204;
          } catch (err) {
            res.statusCode = err.status ?? 400;
          }
          res.end();
        });
      });
    },
  };
}

// --- build (and rebuild), serve ----------------------------------------------------------------

console.log('\n  Building the test copy…');
const watcher = await build({
  root,
  logLevel: 'warn',
  // Turns the test log on (src/testlog.ts).
  define: {__TEST_LOG__: 'true'},
  build: {outDir, emptyOutDir: true, watch: {}},
});
await new Promise((resolve, reject) => {
  let first = true;
  let failed = false;
  watcher.on('event', e => {
    if (e.code === 'BUNDLE_START') failed = false;
    if (e.code === 'ERROR') failed = true;
    if (e.code !== 'END') return;
    if (first) {
      first = false;
      if (failed) reject(new Error('the first build failed (see above)'));
      else resolve();
    } else if (!failed) {
      console.log(`  ${new Date().toLocaleTimeString()}  ↻ rebuilt: reload the page on the phone`);
    }
  });
}).catch(err => {
  console.error(`\n  ${err.message}`);
  process.exit(1);
});

const server = await preview({
  root,
  logLevel: 'warn',
  build: {outDir},
  preview: {port: PORT, host: '127.0.0.1'},
  plugins: [phoneLog()],
});
const localUrl = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${PORT}/`;

let tunnel = null;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (tunnel && tunnel.exitCode === null) {
    // On Windows the tunnel runs under a shell: end the whole tree.
    if (win) spawnSync('taskkill', ['/pid', String(tunnel.pid), '/T', '/F'], {stdio: 'ignore'});
    else tunnel.kill('SIGTERM');
  }
  await Promise.allSettled([watcher.close(), server.close()]);
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

const footer = () => {
  console.log(`  Reload the page on the phone after a rebuild (pull down on any page but a battle, or the browser menu).`);
  console.log(`  Test log: ${rel(logFile)}   Battles: ${rel(battleDir)}/`);
  console.log('  Ctrl+C stops everything.\n');
};

if (localOnly) {
  console.log(`\n  Serving the test copy at ${localUrl.replace('127.0.0.1', 'localhost')} (this PC only).`);
  footer();
} else {
  // --- the tunnel --------------------------------------------------------------------------------
  const installed = spawnSync(win ? 'where' : 'which', ['cloudflared'], {stdio: 'ignore'}).status === 0;
  const bin = installed ? 'cloudflared' : `npx --yes ${CLOUDFLARED}`;
  console.log(`  Opening a Cloudflare quick tunnel${installed ? '' : ' (the first time, npx downloads cloudflared)'}…`);
  tunnel = spawn(`${bin} tunnel --no-autoupdate --url ${localUrl.replace(/\/$/, '')}`, {shell: true, stdio: ['ignore', 'pipe', 'pipe']});
  const recent = [];
  let address = null;
  const read = chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      recent.push(line);
      if (recent.length > 25) recent.shift();
      // The quick tunnel's address is words joined by dashes; api.trycloudflare.com shows up in errors.
      const m = !address && line.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
      if (!m) continue;
      address = m[0];
      console.log('\n  On your phone, scan this or type the address:\n');
      qrcode.generate(address, {small: true}, qr => console.log(qr.replace(/^/gm, '  ')));
      console.log(`  ${address}\n`);
      console.log('  It can take a few seconds to start answering: reload if it doesn’t load at once.');
      footer();
    }
  };
  tunnel.stdout.on('data', read);
  tunnel.stderr.on('data', read);
  tunnel.on('exit', code => {
    if (stopping) return;
    if (!address) {
      console.error(`\n  The tunnel didn't start (exit code ${code}). What it said last:\n`);
      for (const line of recent) console.error(`    ${line}`);
      console.error('\n  If cloudflared itself is the problem, install it and run this again:');
      console.error(win ? '    winget install --id Cloudflare.cloudflared' : '    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      console.error('  Or test on this PC only: npm run phone -- --local\n');
    } else {
      console.error('\n  The tunnel closed. Run npm run phone again (it gets a new address).\n');
    }
    void shutdown(1);
  });
}
