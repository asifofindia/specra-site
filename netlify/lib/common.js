// Shared helpers for the Specra admin functions. No npm packages needed.
const crypto = require('crypto');

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function checkAuth(event) {
  const want = process.env.ADMIN_PASSWORD || '';
  const got = (event.headers['x-admin-password'] || event.headers['X-Admin-Password'] || '');
  if (!want) return 'ADMIN_PASSWORD is not set in Netlify (Project configuration, Environment variables).';
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  if (!crypto.timingSafeEqual(a, b)) return 'Wrong password.';
  return null;
}

function missingEnv(names) {
  const miss = names.filter((n) => !process.env[n]);
  return miss.length ? 'Missing settings in Netlify: ' + miss.join(', ') : null;
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- GitHub (reads and writes the site's data files) ----------
const GH = 'https://api.github.com';
function ghHeaders() {
  return { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'specra-admin', 'X-GitHub-Api-Version': '2022-11-28' };
}
async function ghGetFile(path) {
  const branch = process.env.GITHUB_BRANCH || 'main';
  const r = await fetch(`${GH}/repos/${process.env.GITHUB_REPO}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub could not read ${path} (${r.status}). Check GITHUB_REPO and GITHUB_TOKEN.`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}
async function ghPutFile(path, data, sha, message) {
  const branch = process.env.GITHUB_BRANCH || 'main';
  const r = await fetch(`${GH}/repos/${process.env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, branch, sha, content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64') }),
  });
  if (!r.ok) { const t = await r.text(); const e = new Error(`GitHub could not save ${path} (${r.status}) ${t.slice(0, 160)}`); e.status = r.status; throw e; }
  return r.json();
}

// ---------- Stripe (plain REST, form encoded) ----------
function formEncode(obj) {
  const out = [];
  (function walk(v, k) {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
    else if (typeof v === 'object') Object.keys(v).forEach((kk) => walk(v[kk], k ? `${k}[${kk}]` : kk));
    else out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  })(obj, '');
  return out.join('&');
}
async function stripe(method, path, params) {
  const url = 'https://api.stripe.com/v1/' + path + (method === 'GET' && params ? '?' + formEncode(params) : '');
  const r = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + process.env.STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : formEncode(params || {}),
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('Stripe error ' + r.status)); e.stripe = j.error; throw e; }
  return j;
}

module.exports = { json, checkAuth, missingEnv, slugify, ghGetFile, ghPutFile, stripe };
