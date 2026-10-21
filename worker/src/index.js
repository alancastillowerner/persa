// La Grieta del Persa — Cloudflare Worker (API + webhooks + archivos estáticos de /public)
import { json, fail, now } from './util.js';
import { currentUser, isAdmin, logout, adminLogin, adminLogout, oauthStart, oauthCallback, devLogin } from './auth.js';
import { publicState, me, postPicks, postBuy, postRedeem, appAuth, appSync, leaderboard, invalidateState } from './api.js';
import * as admin from './admin.js';
import { twitchWebhook, kickWebhook, handleRedemption } from './webhooks.js';
import { riotTick, ensureDdragonVersion } from './riot.js';
import { getSetting, setSetting } from './util.js';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function withHeaders(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  // Las escrituras desde el navegador llevan este header: bloquea formularios de otros sitios (CSRF).
  const isWrite = m === 'POST' && p.startsWith('/api/') && !p.startsWith('/api/app/');
  if (isWrite && req.headers.get('x-grieta') !== '1') return fail('Solicitud inválida', 403);

  // ---------- Login ----------
  if (p === '/auth/twitch' && m === 'GET') return oauthStart(req, env, 'twitch');
  if (p === '/auth/kick' && m === 'GET') return oauthStart(req, env, 'kick');
  if (p === '/auth/twitch/callback') return oauthCallback(req, env, 'twitch');
  if (p === '/auth/kick/callback') return oauthCallback(req, env, 'kick');
  if (p === '/auth/dev') return devLogin(req, env);

  // ---------- Webhooks ----------
  if (p === '/webhooks/twitch' && m === 'POST') return twitchWebhook(req, env, ctx);
  if (p === '/webhooks/kick' && m === 'POST') return kickWebhook(req, env, ctx);

  // ---------- API pública ----------
  if (p === '/api/state' && m === 'GET') return json(await publicState(env), 200, { 'cache-control': 'public, max-age=2' });
  if (p === '/api/leaderboard' && m === 'GET') return json({ ok: true, rows: await leaderboard(env, url.searchParams.get('period') === 'all' ? 'all' : 'month', 25) });

  // ---------- Conector de PC ----------
  if (p.startsWith('/api/app/')) {
    if (!(await appAuth(req, env))) return fail('Código de conexión inválido. Generá uno nuevo desde el panel.', 401);
    if (p === '/api/app/sync' && m === 'POST') return appSync(req, env);
    if (p === '/api/app/ping') return json({ ok: true, ...(await publicState(env)).profile });
    return fail('No encontrado', 404);
  }

  // ---------- Panel del streamer ----------
  if (p === '/api/admin/login' && m === 'POST') return adminLogin(req, env);
  if (p.startsWith('/api/admin/')) {
    if (!(await isAdmin(req, env))) return fail('Iniciá sesión en el panel.', 401);
    switch (`${m} ${p}`) {
      case 'POST /api/admin/logout': return adminLogout(req, env);
      case 'GET /api/admin/overview': return admin.overview(req, env);
      case 'POST /api/admin/settings': return admin.saveSettings(req, env);
      case 'POST /api/admin/app-key': return admin.newAppKey(req, env);
      case 'POST /api/admin/twitch/setup': return admin.setupPlatform(req, env, 'twitch');
      case 'POST /api/admin/kick/setup': return admin.setupPlatform(req, env, 'kick');
      case 'POST /api/admin/twitch/disconnect': return admin.disconnectPlatform(req, env, 'twitch');
      case 'POST /api/admin/kick/disconnect': return admin.disconnectPlatform(req, env, 'kick');
      case 'POST /api/admin/market': return admin.adminMarket(req, env);
      case 'GET /api/admin/orders': return admin.listOrders(req, env);
      case 'POST /api/admin/orders': return admin.updateOrder(req, env);
      case 'GET /api/admin/rewards': return admin.listRewards(req, env);
      case 'POST /api/admin/rewards': return admin.saveReward(req, env);
      case 'GET /api/admin/users': return admin.listUsers(req, env);
      case 'POST /api/admin/users': return admin.updateUser(req, env);
      case 'POST /api/admin/test-alert': return admin.testAlert(req, env);
    }
    return fail('No encontrado', 404);
  }

  // ---------- Pruebas locales (solo con DEV_MODE=1) ----------
  if (p === '/api/dev/redeem' && m === 'POST' && env.DEV_MODE === '1') {
    const b = await req.json();
    const rewards = (await getSetting(env, `${b.platform}_rewards`, [])) || [];
    if (!rewards.length) await setSetting(env, `${b.platform}_rewards`, [{ id: 'dev10', fichas: 10, cost: 1000 }]);
    const r = await handleRedemption(env, null, {
      platform: b.platform, redemptionId: `dev${now()}`, rewardId: rewards[0]?.id || 'dev10',
      platformUserId: b.user_id, login: b.login, displayName: b.login, complete: false,
    });
    invalidateState();
    return json(r);
  }

  // ---------- API de usuario ----------
  if (p.startsWith('/api/')) {
    if (p === '/api/logout' && m === 'POST') return logout(req, env);
    const user = await currentUser(req, env);
    if (p === '/api/me' && m === 'GET') return user ? json(await me(env, user)) : json({ ok: true, user: null });
    if (!user) return fail('Tenés que iniciar sesión.', 401);
    if (p === '/api/picks' && m === 'POST') return postPicks(req, env, user);
    if (p === '/api/buy' && m === 'POST') return postBuy(req, env, user);
    if (p === '/api/redeem' && m === 'POST') return postRedeem(req, env, user);
    return fail('No encontrado', 404);
  }

  // ---------- Archivos estáticos ----------
  if (env.ASSETS) return env.ASSETS.fetch(req);
  return new Response('No encontrado', { status: 404 });
}

export default {
  async fetch(req, env, ctx) {
    try {
      return withHeaders(await route(req, env, ctx));
    } catch (e) {
      console.log('Error', e.stack || e.message);
      return fail('Error interno. Probá de nuevo en un momento.', 500);
    }
  },

  // Cron cada minuto: detecta partidas con la API de Riot, resuelve partidas abandonadas y limpia datos viejos.
  async scheduled(event, env, ctx) {
    const jobs = [
      riotTick(env).catch((e) => console.log('riotTick', e.message)),
      ensureDdragonVersion(env),
    ];
    const minute = new Date().getUTCMinutes();
    if (minute === 7) {
      const t = now();
      jobs.push(env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
        env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(t),
        env.DB.prepare('DELETE FROM seen_messages WHERE created_at < ?').bind(t - 7 * 86400_000),
        env.DB.prepare('DELETE FROM feed WHERE id < (SELECT MAX(id) - 500 FROM feed)'),
      ]));
    }
    ctx.waitUntil(Promise.all(jobs).then(() => invalidateState()));
  },
};
