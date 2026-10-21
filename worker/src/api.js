// API pública para la web y los overlays, y API del conector de PC.
import { now, json, fail, getSetting, setSetting, sha256hex, cleanText, addFeed, randomHex } from './util.js';
import { getConfig, DEFAULT_REWARDS } from './config.js';
import { getLiveGame, listMarkets, placePick, buyComodin, processAppSync } from './markets.js';
import { spend, getInventory } from './fichas.js';

// ---------- Estado público (se cachea 2 segundos por instancia para aguantar muchos viewers) ----------
let stateMemo = { at: 0, data: null };

export function invalidateState() {
  stateMemo = { at: 0, data: null };
}

function monthStart() {
  // Mes calendario en hora argentina (UTC-3)
  const d = new Date(Date.now() - 3 * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + 3 * 3600_000;
}

export async function ensureRewards(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rewards').first();
  if (row.n > 0) return;
  const seeded = await getSetting(env, 'rewards_seeded', false);
  if (seeded) return;
  await env.DB.batch(DEFAULT_REWARDS.map((r, i) => env.DB.prepare(
    'INSERT OR IGNORE INTO rewards (id, name, description, cost, stock, icon, needs_note, note_hint, active, sort) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)'
  ).bind(r.id, r.name, r.description, r.cost, r.icon, r.needs_note, r.note_hint, i)));
  await setSetting(env, 'rewards_seeded', true);
}

export async function leaderboard(env, period = 'month', limit = 10) {
  if (period === 'all') {
    const { results } = await env.DB.prepare(
      `SELECT name, avatar, total_won AS won, picks_won, picks_total FROM users WHERE banned = 0 AND total_won > 0 ORDER BY total_won DESC LIMIT ?`
    ).bind(limit).all();
    return results;
  }
  const { results } = await env.DB.prepare(
    `SELECT u.name, u.avatar, SUM(l.delta) AS won, u.picks_won, u.picks_total
     FROM ledger l JOIN users u ON u.id = l.user_id
     WHERE l.ref LIKE 'pick:%' AND l.created_at >= ? AND u.banned = 0
     GROUP BY l.user_id ORDER BY won DESC LIMIT ?`
  ).bind(monthStart(), limit).all();
  return results;
}

export async function publicState(env) {
  if (stateMemo.data && now() - stateMemo.at < 2000) return stateMemo.data;
  await ensureRewards(env);
  const cfg = await getConfig(env);
  const game = await getLiveGame(env);
  const [markets, feed, lastGames, lb, rewards, twitchRewards, kickRewards, app, dd] = await Promise.all([
    listMarkets(env, game?.id || null),
    env.DB.prepare('SELECT id, kind, text, user_name, amount, created_at FROM feed ORDER BY id DESC LIMIT 25').all(),
    env.DB.prepare(`SELECT champion, champion_key, result, kills, deaths, assists, game_time, ended_at FROM games WHERE status = 'ended' AND result != 'void' ORDER BY ended_at DESC LIMIT 6`).all(),
    leaderboard(env, 'month', 10),
    env.DB.prepare('SELECT id, name, description, cost, stock, icon, needs_note, note_hint FROM rewards WHERE active = 1 ORDER BY sort, cost').all(),
    getSetting(env, 'twitch_rewards', []),
    getSetting(env, 'kick_rewards', []),
    getSetting(env, 'app_status', null),
    getSetting(env, 'ddragon', null),
  ]);
  const data = {
    ok: true,
    server_time: now(),
    profile: cfg.profile,
    economy: {
      points_per_ficha: cfg.economy.points_per_ficha,
      packs: cfg.economy.packs,
      welcome_bonus: cfg.economy.welcome_bonus,
      comodines: { x2: cfg.economy.comodin_x2, escudo: cfg.economy.comodin_escudo },
      platforms: {
        twitch: { login: !!env.TWITCH_CLIENT_ID, points: (twitchRewards || []).length > 0 },
        kick: { login: !!env.KICK_CLIENT_ID, points: (kickRewards || []).length > 0 },
      },
    },
    ddragon: dd?.version || null,
    app_online: !!(app && now() - app.last < 90_000),
    game: game && {
      id: game.id, status: game.status, source: game.source, champion: game.champion, champion_key: game.champion_key,
      team: game.team, mode: game.game_mode, game_time: game.game_time, start_epoch: game.start_epoch,
      kills: game.kills, deaths: game.deaths, assists: game.assists, cs: game.cs, updated_at: game.updated_at,
    },
    markets,
    feed: feed.results,
    last_games: lastGames.results,
    leaderboard: lb,
    rewards: rewards.results,
    dev: env.DEV_MODE === '1',
  };
  stateMemo = { at: now(), data };
  return data;
}

// ---------- Datos del usuario ----------
export async function me(env, user) {
  const [inv, picks, orders, ledger, pending] = await Promise.all([
    getInventory(env, user.id),
    env.DB.prepare(
      `SELECT p.market_id, p.option, p.odds, p.boost, p.payout, p.status, p.created_at, m.question, m.options, m.outcome
       FROM picks p JOIN markets m ON m.id = p.market_id WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 40`
    ).bind(user.id).all(),
    env.DB.prepare('SELECT id, reward_name, cost, note, status, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(user.id).all(),
    env.DB.prepare('SELECT delta, reason, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30').bind(user.id).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM pending_credits WHERE claimed_by IS NULL AND ((platform = ? AND platform_user_id = ?) OR (platform = ? AND platform_user_id = ?))')
      .bind('twitch', user.twitch_id || '-', 'kick', user.kick_id || '-').first(),
  ]);
  return {
    ok: true,
    user: {
      id: user.id, name: user.name, avatar: user.avatar, balance: user.balance,
      twitch: user.twitch_login, kick: user.kick_username,
      picks_won: user.picks_won, picks_total: user.picks_total, total_won: user.total_won, banned: !!user.banned,
    },
    inventory: inv,
    picks: picks.results.map((p) => {
      const opts = JSON.parse(p.options);
      return {
        market_id: p.market_id, question: p.question, option: p.option,
        option_label: opts.find((o) => o.key === p.option)?.label || p.option,
        outcome_label: p.outcome ? opts.find((o) => o.key === p.outcome)?.label : null,
        odds: p.odds, boost: p.boost, payout: p.payout, status: p.status, created_at: p.created_at,
      };
    }),
    orders: orders.results,
    ledger: ledger.results,
    pending_credits: pending.n,
  };
}

export async function postPicks(req, env, user) {
  const body = await req.json().catch(() => ({}));
  const list = Array.isArray(body.picks) ? body.picks.slice(0, 12) : [body];
  const results = [];
  for (const p of list) results.push(await placePick(env, user, p));
  invalidateState();
  return json({ ok: results.some((r) => r.ok), results });
}

export async function postBuy(req, env, user) {
  const { item, qty } = await req.json().catch(() => ({}));
  if (user.banned) return fail('Tu cuenta está suspendida.', 403);
  const r = await buyComodin(env, user, item, qty);
  return r.ok ? json(r) : fail(r.error);
}

export async function postRedeem(req, env, user) {
  const { reward_id, note } = await req.json().catch(() => ({}));
  if (user.banned) return fail('Tu cuenta está suspendida.', 403);
  const r = await env.DB.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').bind(reward_id).first();
  if (!r) return fail('Ese premio no existe.');
  if (r.stock !== null && r.stock <= 0) return fail('Ese premio está agotado.');
  const n = cleanText(note, 200);
  if (r.needs_note && !n) return fail(r.note_hint || 'Completá el dato que pide el premio.');
  const orderId = randomHex(8);
  if (!(await spend(env, user.id, r.cost, `Premio: ${r.name}`, `order:${orderId}`))) return fail('No te alcanzan las fichas.');
  const t = now();
  const stmts = [
    env.DB.prepare('INSERT INTO orders (id, user_id, reward_id, reward_name, cost, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(orderId, user.id, r.id, r.name, r.cost, n || null, 'pendiente', t, t),
  ];
  if (r.stock !== null) stmts.push(env.DB.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ? AND stock > 0').bind(r.id));
  await env.DB.batch(stmts);
  await addFeed(env, 'premio', `${user.name} canjeó "${r.name}"`, user.name, r.cost);
  invalidateState();
  return json({ ok: true, order_id: orderId });
}

// ---------- Conector de PC ----------
export async function appAuth(req, env) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  const stored = await getSetting(env, 'app_key_hash', null);
  return !!(key && stored && (await sha256hex(key)) === stored);
}

export async function appSync(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return fail('JSON inválido');
  const cfg = await getConfig(env);
  await setSetting(env, 'app_status', { last: now(), version: cleanText(body.version, 20), in_game: !!body.game, game_time: body.game?.gameTime || 0 });
  const r = await processAppSync(env, body);
  invalidateState();
  return json({ ...r, streamer: cfg.profile.name, site: cfg.profile.site });
}
