// Panel del streamer.
import { now, json, fail, getSetting, setSetting, randomHex, sha256hex, b64urlText, cleanText, baseUrl, invalidateSettings, addFeed } from './util.js';
import { getConfig, DEFAULT_PROFILE, DEFAULT_ECONOMY, DEFAULT_MARKETS, DEFAULT_RIOT } from './config.js';
import { credit } from './fichas.js';
import { getLiveGame, listMarkets, resolveMarket, createCustomMarket, voidGame } from './markets.js';
import { setupTwitch, setupKick } from './platforms.js';
import { invalidateState, ensureRewards } from './api.js';
import { resolvePuuid } from './riot.js';

export async function overview(req, env) {
  await ensureRewards(env);
  const cfg = await getConfig(env);
  const [tw, kk, twR, kkR, app, appKey, game, users, circ, pending, revoked] = await Promise.all([
    getSetting(env, 'twitch_broadcaster', null), getSetting(env, 'kick_broadcaster', null),
    getSetting(env, 'twitch_rewards', []), getSetting(env, 'kick_rewards', []),
    getSetting(env, 'app_status', null), getSetting(env, 'app_key_hash', null),
    getLiveGame(env),
    env.DB.prepare('SELECT COUNT(*) AS n FROM users').first(),
    env.DB.prepare('SELECT COALESCE(SUM(balance), 0) AS n FROM users').first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pendiente'`).first(),
    getSetting(env, 'twitch_eventsub_revoked', null),
  ]);
  return json({
    ok: true,
    base_url: baseUrl(env, req),
    config: cfg,
    env: {
      twitch_app: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET), twitch_secret: !!env.TWITCH_EVENTSUB_SECRET,
      kick_app: !!(env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET), riot_key: !!env.RIOT_API_KEY, dev: env.DEV_MODE === '1',
    },
    twitch: tw ? { login: tw.login, name: tw.name, rewards: twR, revoked } : null,
    kick: kk ? { login: kk.login, name: kk.name, rewards: kkR } : null,
    app: { configured: !!appKey, last: app?.last || null, in_game: app?.in_game || false, version: app?.version || null },
    game: game || null,
    markets: await listMarkets(env, game?.id || null),
    stats: { users: users.n, circulating: circ.n, pending_orders: pending.n },
  });
}

export async function saveSettings(req, env) {
  const body = await req.json().catch(() => ({}));
  const pick = (src, defaults) => {
    const out = {};
    for (const k of Object.keys(defaults)) if (src && src[k] !== undefined) out[k] = src[k];
    return out;
  };
  if (body.profile) {
    const p = pick(body.profile, DEFAULT_PROFILE);
    for (const k of Object.keys(p)) p[k] = cleanText(p[k], k === 'tagline' ? 140 : 300);
    await setSetting(env, 'profile', { ...(await getSetting(env, 'profile', {})), ...p });
  }
  if (body.economy) {
    const e = pick(body.economy, DEFAULT_ECONOMY);
    for (const k of Object.keys(e)) {
      if (k === 'packs') e.packs = [...new Set((Array.isArray(e.packs) ? e.packs : String(e.packs).split(',')).map((x) => parseInt(x, 10)).filter((x) => x > 0 && x <= 10000))].slice(0, 6).sort((a, b) => a - b);
      else e[k] = Math.max(0, parseInt(e[k], 10) || 0);
    }
    if (e.points_per_ficha !== undefined && e.points_per_ficha < 1) return fail('Los puntos por ficha tienen que ser al menos 1.');
    await setSetting(env, 'economy', { ...(await getSetting(env, 'economy', {})), ...e });
  }
  if (body.markets) {
    const m = pick(body.markets, DEFAULT_MARKETS);
    for (const k of Object.keys(m)) {
      if (k.endsWith('_line')) m[k] = parseFloat(m[k]) || DEFAULT_MARKETS[k];
      else if (k === 'pregame_close') m[k] = Math.max(60, Math.min(900, parseInt(m[k], 10) || 240));
      else if (k === 'ignore_modes') m[k] = Array.isArray(m[k]) ? m[k] : DEFAULT_MARKETS.ignore_modes;
      else m[k] = !!m[k];
    }
    await setSetting(env, 'markets_cfg', { ...(await getSetting(env, 'markets_cfg', {})), ...m });
  }
  if (body.riot) {
    const r = pick(body.riot, DEFAULT_RIOT);
    const prev = await getSetting(env, 'riot', {});
    const next = { ...prev, ...r, game_name: cleanText(r.game_name ?? prev.game_name, 40), tag_line: cleanText(r.tag_line ?? prev.tag_line, 10).replace(/^#/, '') };
    if (next.game_name !== prev.game_name || next.tag_line !== prev.tag_line) next.puuid = '';
    await setSetting(env, 'riot', next);
    if (env.RIOT_API_KEY && next.game_name && next.tag_line) {
      try {
        await resolvePuuid(env, { ...DEFAULT_RIOT, ...next });
      } catch (e) {
        invalidateSettings();
        return fail(e.message);
      }
    }
  }
  invalidateSettings();
  invalidateState();
  return json({ ok: true });
}

export async function newAppKey(req, env) {
  const key = randomHex(24);
  await setSetting(env, 'app_key_hash', await sha256hex(key));
  const cfg = await getConfig(env);
  const code = 'GRIETA-' + b64urlText(JSON.stringify({ u: baseUrl(env, req), k: key, n: cfg.profile.site }));
  return json({ ok: true, code });
}

export async function setupPlatform(req, env, platform) {
  try {
    const r = platform === 'twitch' ? await setupTwitch(env, baseUrl(env, req)) : await setupKick(env, baseUrl(env, req));
    invalidateState();
    return json({ ok: true, ...r });
  } catch (e) {
    return fail(e.message);
  }
}

export async function disconnectPlatform(req, env, platform) {
  await env.DB.prepare('DELETE FROM settings WHERE key IN (?, ?)').bind(`${platform}_broadcaster`, `${platform}_rewards`).run();
  invalidateSettings();
  invalidateState();
  return json({ ok: true });
}

// ---------- Pronósticos ----------
export async function adminMarket(req, env) {
  const b = await req.json().catch(() => ({}));
  if (b.action === 'create') {
    const question = cleanText(b.question, 120);
    const options = (b.options || []).map((o) => cleanText(o, 40)).filter(Boolean).slice(0, 4);
    if (!question || options.length < 2) return fail('Escribí la pregunta y al menos 2 opciones.');
    const minutes = Math.max(0.5, Math.min(120, parseFloat(b.minutes) || 3));
    const game = await getLiveGame(env);
    const id = await createCustomMarket(env, { question, options, minutes, base: parseInt(b.base, 10) || null, gameId: game?.id });
    invalidateState();
    return json({ ok: true, id });
  }
  if (b.action === 'resolve') {
    const ok = await resolveMarket(env, b.id, b.outcome === 'void' ? 'void' : b.outcome);
    invalidateState();
    return ok ? json({ ok: true }) : fail('Ese pronóstico ya estaba resuelto.');
  }
  if (b.action === 'close') {
    await env.DB.prepare(`UPDATE markets SET closes_at = ? WHERE id = ? AND status = 'open'`).bind(now(), b.id).run();
    invalidateState();
    return json({ ok: true });
  }
  if (b.action === 'void_game') {
    const game = await getLiveGame(env);
    if (!game) return fail('No hay partida en curso.');
    await voidGame(env, game, 'anulada por el streamer');
    invalidateState();
    return json({ ok: true });
  }
  return fail('Acción desconocida');
}

// ---------- Premios y canjes ----------
export async function listOrders(req, env) {
  const status = new URL(req.url).searchParams.get('status') || 'pendiente';
  const { results } = await env.DB.prepare(
    `SELECT o.*, u.name AS user_name, u.twitch_login, u.kick_username FROM orders o JOIN users u ON u.id = o.user_id
     WHERE (? = 'todos' OR o.status = ?) ORDER BY o.created_at DESC LIMIT 100`
  ).bind(status, status).all();
  return json({ ok: true, orders: results });
}

export async function updateOrder(req, env) {
  const { id, status } = await req.json().catch(() => ({}));
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!o) return fail('Canje no encontrado.');
  if (o.status !== 'pendiente') return fail('Ese canje ya fue procesado.');
  if (status === 'devuelto') {
    await credit(env, o.user_id, o.cost, `Devolución: ${o.reward_name}`, `refund:${o.id}`);
    if (o.reward_id) await env.DB.prepare('UPDATE rewards SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL').bind(o.reward_id).run();
  } else if (status !== 'cumplido') return fail('Estado inválido.');
  await env.DB.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
  return json({ ok: true });
}

export async function listRewards(req, env) {
  await ensureRewards(env);
  const { results } = await env.DB.prepare('SELECT * FROM rewards ORDER BY sort, cost').all();
  return json({ ok: true, rewards: results });
}

export async function saveReward(req, env) {
  const b = await req.json().catch(() => ({}));
  if (b.delete) {
    await env.DB.prepare('DELETE FROM rewards WHERE id = ?').bind(b.id).run();
    invalidateState();
    return json({ ok: true });
  }
  const name = cleanText(b.name, 60);
  const cost = parseInt(b.cost, 10);
  if (!name || !(cost > 0)) return fail('El premio necesita nombre y costo.');
  const stock = b.stock === '' || b.stock === null || b.stock === undefined ? null : Math.max(0, parseInt(b.stock, 10) || 0);
  const id = b.id || randomHex(6);
  await env.DB.prepare(
    `INSERT INTO rewards (id, name, description, cost, stock, icon, needs_note, note_hint, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, cost = excluded.cost, stock = excluded.stock,
       icon = excluded.icon, needs_note = excluded.needs_note, note_hint = excluded.note_hint, active = excluded.active, sort = excluded.sort`
  ).bind(id, name, cleanText(b.description, 200), cost, stock, cleanText(b.icon || 'star', 20), b.needs_note ? 1 : 0, cleanText(b.note_hint, 60),
    b.active === false ? 0 : 1, parseInt(b.sort, 10) || 0).run();
  invalidateState();
  return json({ ok: true, id });
}

// ---------- Usuarios ----------
export async function listUsers(req, env) {
  const q = cleanText(new URL(req.url).searchParams.get('q') || '', 40).toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT id, name, twitch_login, kick_username, balance, picks_won, picks_total, banned, created_at FROM users
     WHERE ? = '' OR lower(name) LIKE ? OR lower(twitch_login) LIKE ? OR lower(kick_username) LIKE ?
     ORDER BY balance DESC LIMIT 50`
  ).bind(q, `%${q}%`, `%${q}%`, `%${q}%`).all();
  const pending = await env.DB.prepare('SELECT platform, platform_name, SUM(fichas) AS fichas, COUNT(*) AS n FROM pending_credits WHERE claimed_by IS NULL GROUP BY platform, platform_user_id ORDER BY fichas DESC LIMIT 30').all();
  return json({ ok: true, users: results, pending: pending.results });
}

export async function updateUser(req, env) {
  const b = await req.json().catch(() => ({}));
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(b.id).first();
  if (!u) return fail('Usuario no encontrado.');
  if (b.delta) {
    const d = parseInt(b.delta, 10);
    if (!d) return fail('Cantidad inválida.');
    await credit(env, u.id, d, cleanText(b.reason || 'Ajuste del streamer', 80), `admin:${randomHex(8)}`);
    if (d > 0 && b.announce) await addFeed(env, 'regalo', `${u.name} recibió ${d} fichas de regalo`, u.name, d);
  }
  if (b.banned !== undefined) await env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(b.banned ? 1 : 0, u.id).run();
  invalidateState();
  return json({ ok: true });
}

export async function testAlert(req, env) {
  const { kind } = await req.json().catch(() => ({}));
  if (kind === 'premio') await addFeed(env, 'premio', 'Prueba canjeó "Saludo en vivo"', 'Prueba', 300);
  else await addFeed(env, 'carga', 'Prueba cargó 10 fichas con puntos de canal', 'Prueba', 10);
  invalidateState();
  return json({ ok: true });
}
