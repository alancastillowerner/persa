// Inicio de sesión con Twitch y Kick (viewers), conexión del canal del streamer y sesión del panel.
import { now, randomHex, b64url, sha256, sha256hex, getCookie, cookie, clearCookie, redirect, json, fail, safeEqual, baseUrl, setSetting, cleanText } from './util.js';
import { PLATFORM, exchangeCode, fetchProfile } from './platforms.js';
import { findByPlatform, createUser, getUser, claimPending, mergeUsers } from './fichas.js';

const USER_DAYS = 30;
const ADMIN_DAYS = 7;

export async function currentUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const s = await env.DB.prepare(`SELECT user_id FROM sessions WHERE token = ? AND kind = 'user' AND expires_at > ?`).bind(await sha256hex(token), now()).first();
  return s ? getUser(env, s.user_id) : null;
}

export async function isAdmin(req, env) {
  const token = getCookie(req, 'aid');
  if (!token) return false;
  const s = await env.DB.prepare(`SELECT token FROM sessions WHERE token = ? AND kind = 'admin' AND expires_at > ?`).bind(await sha256hex(token), now()).first();
  return !!s;
}

async function newSession(env, kind, userId, days) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, kind, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256hex(token), userId, kind, now() + days * 86400_000).run();
  return token;
}

export async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': clearCookie('sid') });
}

export async function adminLogin(req, env) {
  const { password } = await req.json().catch(() => ({}));
  if (!env.ADMIN_PASSWORD) return fail('Falta configurar ADMIN_PASSWORD en Cloudflare.', 503);
  const ok = safeEqual(await sha256hex(String(password || '')), await sha256hex(env.ADMIN_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800));
    return fail('Contraseña incorrecta.', 401);
  }
  const token = await newSession(env, 'admin', null, ADMIN_DAYS);
  return json({ ok: true }, 200, { 'set-cookie': cookie('aid', token, ADMIN_DAYS * 86400) });
}

export async function adminLogout(req, env) {
  const token = getCookie(req, 'aid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': clearCookie('aid') });
}

// ---------- OAuth ----------
// mode: 'login' (viewer), 'link' (vincular otra plataforma a la cuenta), 'broadcaster' (canal del streamer, desde el panel)
export async function oauthStart(req, env, platform) {
  const url = new URL(req.url);
  const mode = ['login', 'link', 'broadcaster'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'login';
  const clientId = platform === 'twitch' ? env.TWITCH_CLIENT_ID : env.KICK_CLIENT_ID;
  if (!clientId) return redirect(`/?error=${encodeURIComponent(`El inicio con ${platform === 'twitch' ? 'Twitch' : 'Kick'} todavía no está configurado.`)}`);
  if (mode === 'broadcaster' && !(await isAdmin(req, env))) return redirect('/panel.html?error=sesion');

  const state = randomHex(16);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const back = cleanText(url.searchParams.get('back') || '', 200);
  await env.DB.prepare('INSERT INTO oauth_states (state, data, expires_at) VALUES (?, ?, ?)')
    .bind(state, JSON.stringify({ platform, mode, verifier, back }), now() + 10 * 60_000).run();

  const redirectUri = `${baseUrl(env, req)}/auth/${platform}/callback`;
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state,
    scope: mode === 'broadcaster' ? PLATFORM[platform].broadcasterScopes : PLATFORM[platform].viewerScopes,
  });
  if (platform === 'kick') {
    p.set('code_challenge', b64url(await sha256(verifier)));
    p.set('code_challenge_method', 'S256');
  }
  if (platform === 'twitch' && mode === 'broadcaster') p.set('force_verify', 'true');
  return redirect(`${PLATFORM[platform].authorize}?${p}`);
}

export async function oauthCallback(req, env, platform) {
  const url = new URL(req.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const row = state && (await env.DB.prepare('SELECT data FROM oauth_states WHERE state = ? AND expires_at > ?').bind(state, now()).first());
  if (state) await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  if (!row || !code) return redirect(`/?error=${encodeURIComponent('No se pudo iniciar sesión. Probá de nuevo.')}`);
  const st = JSON.parse(row.data);
  if (st.platform !== platform) return redirect('/?error=plataforma');

  try {
    const tok = await exchangeCode(env, platform, code, `${baseUrl(env, req)}/auth/${platform}/callback`, st.verifier);
    const prof = await fetchProfile(env, platform, tok.access_token);

    if (st.mode === 'broadcaster') {
      if (!(await isAdmin(req, env))) return redirect('/panel.html?error=sesion');
      await setSetting(env, `${platform}_broadcaster`, { ...tok, id: prof.id, login: prof.login, name: prof.name });
      return redirect(`/panel.html?ok=${platform}#conexiones`);
    }
    return finishViewerLogin(req, env, platform, prof, st);
  } catch (e) {
    return redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
}

export async function finishViewerLogin(req, env, platform, prof, st = { mode: 'login' }) {
  const col = platform === 'twitch' ? ['twitch_id', 'twitch_login'] : ['kick_id', 'kick_username'];
  let user = await findByPlatform(env, platform, prof.id);
  const current = await currentUser(req, env);

  if (st.mode === 'link' && current) {
    if (user && user.id !== current.id) await mergeUsers(env, current.id, user.id);
    await env.DB.prepare(`UPDATE users SET ${col[0]} = ?, ${col[1]} = ?, avatar = COALESCE(avatar, ?) WHERE id = ?`)
      .bind(prof.id, prof.login, prof.avatar, current.id).run();
    await claimPending(env, current.id, platform, prof.id);
    return redirect(`/?ok=vinculado`);
  }

  if (!user) user = await createUser(env, platform, prof);
  else {
    await env.DB.prepare(`UPDATE users SET name = ?, avatar = ?, ${col[1]} = ? WHERE id = ?`).bind(prof.name, prof.avatar, prof.login, user.id).run();
    await claimPending(env, user.id, platform, prof.id);
  }
  const token = await newSession(env, 'user', user.id, USER_DAYS);
  return redirect(st.back && st.back.startsWith('/') ? st.back : '/?ok=login', [cookie('sid', token, USER_DAYS * 86400)]);
}

// Solo para pruebas locales (DEV_MODE=1): entra sin Twitch/Kick.
export async function devLogin(req, env) {
  if (env.DEV_MODE !== '1') return fail('No disponible', 404);
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform') === 'kick' ? 'kick' : 'twitch';
  const name = cleanText(url.searchParams.get('name') || 'tester', 25);
  const id = url.searchParams.get('id') || `dev_${name.toLowerCase()}`;
  return finishViewerLogin(req, env, platform, { id, login: name.toLowerCase(), name, avatar: null }, { mode: url.searchParams.get('mode') || 'login' });
}
