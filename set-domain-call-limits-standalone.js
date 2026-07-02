#!/usr/bin/env node
/**
 * set-domain-call-limits-standalone.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone, interactive tool to bulk-set external call paths (`call_limit_ext`)
 * on every domain in a SkySwitch / NetSapiens NS-API territory, sized to each
 * domain's live device count.
 *
 * Self-contained: no database, no repo dependencies. It authenticates
 * to the NS-API itself (OAuth2 password grant), then reads device counts LIVE
 * from the API per domain. Requires only Node.js 18+ (for global fetch).
 *
 * Formula:  paths = clamp( round(deviceCount * ratio), min, max )
 *
 * The script interactively prompts for: territory, API base URL, credentials,
 * and the min / max / ratio knobs. It ALWAYS previews (dry run) and only writes
 * when you explicitly choose to apply and confirm.
 *
 * Run:  node set-domain-call-limits-standalone.js
 *
 * Non-interactive: any prompt can be pre-answered with an env var, so it can run
 * unattended in CI once configured:
 *   SS_TERRITORY, SS_CLIENT_ID, SS_USERNAME, SS_PASSWORD,
 *   SS_BASE_URL (optional override of the territory-derived NS-API host),
 *   SS_CLIENT_SECRET, SS_MIN, SS_MAX, SS_RATIO, SS_APPLY (=yes to write),
 *   SS_RATE_MS (min ms between API calls, default 2200 => ~1 call / 2s)
 *
 * Rate limiting: every NS-API call is spaced >= SS_RATE_MS apart (default 2200ms,
 * i.e. at most ~1 call every 2 seconds). On HTTP 429 the script pauses 30 seconds
 * and automatically retries (up to 5 times) before giving up on that call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const readline = require('readline');

if (typeof fetch !== 'function') {
  console.error('This script requires Node.js 18+ (global fetch). Your version: ' + process.version);
  process.exit(1);
}

// ─── Prompt helpers ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, def) {
  const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      const val = (answer && answer.trim()) || (def !== undefined ? String(def) : '');
      resolve(val);
    });
  });
}

// Masked prompt — rewrites the current line as asterisks on every keystroke.
function askHidden(question) {
  return new Promise((resolve) => {
    const onData = () => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question + ': ' + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(question + ': ', (value) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value.trim());
    });
  });
}

function envOr(name) {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : undefined;
}

// Ask, but skip the prompt if the env var is already set. When allowEmptyEnv is
// true, a defined-but-empty env var (e.g. SS_CLIENT_SECRET='') is accepted as a
// real answer instead of falling through to an interactive prompt.
async function askOrEnv(envName, question, def, hidden, allowEmptyEnv) {
  const preset = allowEmptyEnv ? process.env[envName] : envOr(envName);
  if (preset !== undefined) {
    console.log(`${question}: (from ${envName})`);
    return preset;
  }
  return hidden ? askHidden(question) : ask(question, def);
}

function yn(s, def) {
  if (!s) return def;
  return /^y(es)?$/i.test(s.trim());
}

// ─── Core formula ────────────────────────────────────────────────────────────
function computePaths(deviceCount, ratio, min, max) {
  const d = Number.isFinite(deviceCount) ? deviceCount : 0;
  const p = Math.round(d * ratio); // half-up
  return Math.min(max, Math.max(min, p));
}

// ─── Rate-limit gate ─────────────────────────────────────────────────────────
let RATE_MS = 2200;            // >= this many ms between every NS-API call (~1 call / 2s)
const RETRY_429_MS = 30000;    // pause on HTTP 429 before auto-retrying
const MAX_429_RETRIES = 5;     // give up on a single call after this many 429s
let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + RATE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// ─── NS-API client ───────────────────────────────────────────────────────────
async function oauthToken(base, clientId, username, password, secret) {
  const body = new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password });
  if (secret) body.set('client_secret', secret);
  const res = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth response contained no access_token');
  return { token: data.access_token, expiresIn: data.expires_in };
}

// POST an NS-API object/action. `params` -> query string (+format=json),
// `body` -> form body (territory injected automatically). Throttled + 429-aware.
async function nsApi(cfg, params, body) {
  const qs = new URLSearchParams({ ...params, format: 'json' }).toString();
  const form = new URLSearchParams({ territory: cfg.territory, ...body }).toString();
  let retries429 = 0;
  while (true) {
    await throttle();
    const res = await fetch(`${cfg.base}/?${qs}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      if (retries429 >= MAX_429_RETRIES) {
        throw new Error(`NS-API ${params.object}/${params.action} failed: 429 after ${retries429} retries`);
      }
      retries429++;
      console.warn(`  [429] rate limited — pausing ${RETRY_429_MS / 1000}s then retrying (attempt ${retries429}/${MAX_429_RETRIES})`);
      await new Promise((r) => setTimeout(r, RETRY_429_MS));
      continue;
    }
    if (!res.ok) throw new Error(`NS-API ${params.object}/${params.action} failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!text || text.trim() === '') return { success: true }; // empty body on successful update
    try { return JSON.parse(text); } catch { return { success: true, raw: text }; }
  }
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.domain)) return data.domain;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function normalizeLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== SkySwitch / NetSapiens — bulk set external call paths (call_limit_ext) ===\n');

  // 1) Territory -> NS-API host. Auth AND all API calls target the territory's
  // SkySwitch host, derived from the territory collected here:
  //   https://{territory}-hpbx.dashmanager.com/ns-api
  // (override with SS_BASE_URL only if you have a non-standard NS-API host.)
  const territory = await askOrEnv('SS_TERRITORY', 'Territory code', '20243');
  const base = (envOr('SS_BASE_URL') || `https://${territory}-hpbx.dashmanager.com/ns-api`).replace(/\/+$/, '');

  // 2) Credentials
  const clientId = await askOrEnv('SS_CLIENT_ID', 'OAuth client_id', `${territory}.n8n`);
  const username = await askOrEnv('SS_USERNAME', 'API username');
  const password = await askOrEnv('SS_PASSWORD', 'API password', undefined, true);
  const secret = await askOrEnv('SS_CLIENT_SECRET', 'OAuth client_secret (blank if none)', '', false, true);

  // 3) Sizing knobs
  const min = parseInt(await askOrEnv('SS_MIN', 'Minimum call paths (floor)', '4'), 10);
  const max = parseInt(await askOrEnv('SS_MAX', 'Maximum call paths (cap)', '30'), 10);
  const ratio = parseFloat(await askOrEnv('SS_RATIO', 'Call-paths-per-device ratio', '0.75'));
  RATE_MS = parseInt(envOr('SS_RATE_MS') || '2200', 10);

  if (!(min >= 0) || !(max >= min) || !(ratio > 0)) {
    console.error('\nInvalid sizing: need min >= 0, max >= min, ratio > 0.');
    process.exit(1);
  }

  // 4) Mode (dry run vs apply)
  const applyPreset = envOr('SS_APPLY');
  let apply;
  if (applyPreset !== undefined) apply = yn(applyPreset, false);
  else apply = yn(await ask('Apply changes? (n = dry run, no writes)', 'n'), false);

  console.log('\n--- Configuration ---');
  console.log(`  Territory : ${territory}`);
  console.log(`  Host      : ${base}  (auth + API)`);
  console.log(`  Auth URL  : ${base}/oauth2/token`);
  console.log(`  client_id : ${clientId}`);
  console.log(`  Sizing    : paths = clamp(round(devices * ${ratio}), ${min}, ${max})`);
  console.log(`  Rate      : >= ${RATE_MS}ms between API calls`);
  console.log(`  Mode      : ${apply ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log('---------------------\n');

  // 5) Authenticate
  process.stdout.write('Authenticating to NS-API... ');
  const { token, expiresIn } = await oauthToken(base, clientId, username, password, secret);
  console.log(`OK (token expires in ${expiresIn ? Math.round(expiresIn / 60) + ' min' : 'unknown'}).`);
  const cfg = { base, territory, token };

  // 6) List domains
  process.stdout.write('Fetching domain list... ');
  let domains = asArray(await nsApi(cfg, { object: 'domain', action: 'read' }, {}))
    .filter((d) => d && typeof d.domain === 'string' && d.domain.trim() !== '')
    .filter((d) => d.domain.split('.')[0] !== '0000'); // skip admin domain
  console.log(`${domains.length} domains.\n`);

  // 7) Confirm before live writes
  if (apply) {
    const ok = yn(await ask(`Proceed with LIVE updates to up to ${domains.length} domains?`, 'n'), false);
    if (!ok) { console.log('Aborted. No changes made.'); rl.close(); return; }
    console.log('');
  }

  // 8) Process
  console.log('domain,deviceCount,currentLimit,newLimit,action');
  const summary = { updated: 0, unchanged: 0, errored: 0 };

  for (const d of domains) {
    const domain = d.domain;
    const currentLimit = normalizeLimit(d.call_limit_ext);
    try {
      // LIVE device count — provisioned devices on the domain
      const devData = await nsApi(cfg, { object: 'device', action: 'read' }, { domain });
      const count = asArray(devData).length;
      const newLimit = computePaths(count, ratio, min, max);

      let action;
      if (currentLimit !== null && currentLimit === newLimit) {
        action = 'unchanged';
        summary.unchanged++;
      } else if (!apply) {
        action = 'would-update';
      } else {
        await nsApi(cfg, { object: 'domain', action: 'update' }, {
          domain,
          call_limit_ext: String(newLimit),
        });
        action = 'updated';
        summary.updated++;
      }
      console.log(`${domain},${count},${currentLimit === null ? '' : currentLimit},${newLimit},${action}`);
    } catch (err) {
      summary.errored++;
      console.log(`${domain},,,,ERROR: ${err.message}`);
    }
  }

  // 9) Summary
  console.log('\n=== Summary ===');
  if (apply) {
    console.log(`updated:   ${summary.updated}`);
    console.log(`unchanged: ${summary.unchanged}`);
  } else {
    const wouldUpdate = domains.length - summary.unchanged - summary.errored;
    console.log(`would-update: ${wouldUpdate}`);
    console.log(`unchanged:    ${summary.unchanged}`);
    console.log('(dry run — re-run and choose "Apply changes? y" to write these.)');
  }
  console.log(`errored:   ${summary.errored}`);
  if (summary.errored) console.log('Re-run to retry errored domains (already-correct ones are skipped as "unchanged").');
}

main()
  .catch((err) => { console.error('\nFatal:', err.message); process.exitCode = 1; })
  .finally(() => rl.close());
