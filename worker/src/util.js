// Utilidades compartidas: respuestas, cookies, criptografía, settings.

export const now = () => Date.now();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const fail = (error, status = 400) => json({ ok: false, error }, status);

export function redirect(url, cookies = []) {
  const h = new Headers({ location: url });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
}

export function randomHex(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const x of arr) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlText(text) {
  return b64url(new TextEncoder().encode(text));
}

export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function sha256hex(text) {
  return [...(await sha256(text))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function getCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function cleanText(s, max = 200) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function baseUrl(env, req) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  return new URL(req.url).origin;
}

// ---------- settings (clave/valor en D1, con caché corta en memoria) ----------
const settingsCache = new Map();

export async function getSetting(env, key, fallback = null) {
  const c = settingsCache.get(key);
  if (c && c.exp > now()) return structuredClone(c.val);
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  const val = row ? JSON.parse(row.value) : fallback;
  settingsCache.set(key, { val, exp: now() + 3000 });
  return structuredClone(val);
}

export async function setSetting(env, key, value) {
  settingsCache.delete(key);
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value))
    .run();
}

export function invalidateSettings() {
  settingsCache.clear();
}

export async function addFeed(env, kind, text, userName = null, amount = null) {
  await env.DB.prepare('INSERT INTO feed (kind, text, user_name, amount, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(kind, text, userName, amount, now())
    .run();
}

export function normName(n) {
  return String(n || '').split('#')[0].trim().toLowerCase();
}
