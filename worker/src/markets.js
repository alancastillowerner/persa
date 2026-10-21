// Partidas y pronósticos: creación, cuotas, picks y resolución.
import { now, randomHex, addFeed, normName, clamp } from './util.js';
import { getConfig } from './config.js';
import { credit, spend, useInventory, addInventory } from './fichas.js';

// Picks hechos dentro de esta ventana antes del evento que resuelve el pronóstico se anulan
// (el stream tiene delay y alguien podría estar mirando la partida desde otro lado).
export const SNIPE_MS = 30_000;

// ---------- Definición de los minijuegos ----------
function marketDefs(cfg, name) {
  const m = cfg.markets;
  return [
    m.win && { kind: 'win', grp: 'partida', close: m.pregame_close, question: `¿${name} gana la partida?`, options: [['si', 'Gana'], ['no', 'Pierde']] },
    m.kills && { kind: 'kills', grp: 'partida', close: m.pregame_close, line: m.kills_line, question: `Kills de ${name}`, options: [['mas', `Más de ${m.kills_line}`], ['menos', `Menos de ${m.kills_line}`]] },
    m.deaths && { kind: 'deaths', grp: 'partida', close: m.pregame_close, line: m.deaths_line, question: `Muertes de ${name}`, options: [['mas', `Más de ${m.deaths_line}`], ['menos', `Menos de ${m.deaths_line}`]] },
    m.duration && { kind: 'duration', grp: 'partida', close: m.pregame_close, line: m.duration_line, question: `¿La partida dura más de ${m.duration_line}:00?`, options: [['si', 'Sí'], ['no', 'No']] },
    m.firstblood && { kind: 'firstblood', grp: 'primeros', close: 60, needsApp: true, question: '¿Su equipo hace la primera sangre?', options: [['si', 'Sí'], ['no', 'No']] },
    m.death10 && { kind: 'death10', grp: 'primeros', close: 180, needsApp: true, question: `¿${name} muere antes del minuto 10?`, options: [['si', 'Sí'], ['no', 'No']] },
    m.firstdragon && { kind: 'firstdragon', grp: 'primeros', close: 300, needsApp: true, question: '¿Su equipo mata el primer dragón?', options: [['si', 'Sí'], ['no', 'No']] },
  ].filter(Boolean);
}

export function computeOdds(counts, total, k) {
  // Lo menos elegido paga más. Sin votos: 1.80 en un sí/no.
  const out = {};
  for (const key of Object.keys(counts)) {
    const raw = (0.9 * (total + 2 * k)) / (counts[key] + 2);
    out[key] = Math.round(clamp(raw, 1.1, 6) * 100) / 100;
  }
  return out;
}

async function marketCounts(env, marketId) {
  const { results } = await env.DB.prepare('SELECT option, COUNT(*) AS n FROM picks WHERE market_id = ? GROUP BY option').bind(marketId).all();
  const map = {};
  for (const r of results) map[r.option] = r.n;
  return map;
}

export function decorateMarket(m, counts) {
  const opts = JSON.parse(m.options);
  const c = {};
  let total = 0;
  for (const o of opts) {
    c[o.key] = counts[o.key] || 0;
    total += c[o.key];
  }
  const odds = computeOdds(c, total, opts.length);
  const t = now();
  const status = m.status === 'open' && t >= m.closes_at ? 'closed' : m.status;
  return {
    id: m.id, game_id: m.game_id, kind: m.kind, grp: m.grp, question: m.question, line: m.line, base: m.base,
    status, closes_at: m.closes_at, outcome: m.outcome, resolved_at: m.resolved_at, total,
    options: opts.map((o) => ({ key: o.key, label: o.label, count: c[o.key], pct: total ? Math.round((c[o.key] * 100) / total) : 0, odds: odds[o.key] })),
  };
}

export async function listMarkets(env, gameId) {
  const { results: markets } = gameId
    ? await env.DB.prepare(`SELECT * FROM markets WHERE game_id = ? OR (game_id IS NULL AND (status = 'open' OR resolved_at > ?)) ORDER BY sort, created_at`).bind(gameId, now() - 3600_000).all()
    : await env.DB.prepare(`SELECT * FROM markets WHERE status = 'open' OR resolved_at > ? ORDER BY resolved_at DESC, created_at DESC LIMIT 12`).bind(now() - 3600_000).all();
  if (!markets.length) return [];
  const ids = markets.map((m) => m.id);
  const { results: rows } = await env.DB.prepare(
    `SELECT market_id, option, COUNT(*) AS n FROM picks WHERE market_id IN (${ids.map(() => '?').join(',')}) GROUP BY market_id, option`
  ).bind(...ids).all();
  const byMarket = {};
  for (const r of rows) (byMarket[r.market_id] ||= {})[r.option] = r.n;
  return markets.map((m) => decorateMarket(m, byMarket[m.id] || {}));
}

// ---------- Partidas ----------
export async function getLiveGame(env) {
  return env.DB.prepare(`SELECT * FROM games WHERE status IN ('live', 'ending') ORDER BY created_at DESC LIMIT 1`).first();
}

export async function createGame(env, g, hasApp) {
  const cfg = await getConfig(env);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO games (id, source, status, champion, champion_key, team, game_mode, game_time, start_epoch, created_at, updated_at)
     VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(g.id, g.source, g.champion || null, g.champion_key || null, g.team || null, g.game_mode || null, g.game_time || 0, g.start_epoch, t, t).run();

  const stmts = [];
  let sort = 0;
  for (const d of marketDefs(cfg, cfg.profile.name)) {
    if (d.needsApp && !hasApp) continue;
    const closesAt = g.start_epoch + d.close * 1000;
    if (closesAt < t + 25_000) continue; // si la partida ya va avanzada, ese pronóstico no tiene sentido
    stmts.push(env.DB.prepare(
      `INSERT INTO markets (id, game_id, kind, grp, question, options, line, base, status, closes_at, close_gt, created_at, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    ).bind(randomHex(8), g.id, d.kind, d.grp, d.question, JSON.stringify(d.options.map(([key, label]) => ({ key, label }))),
      d.line ?? null, cfg.economy.base_reward, closesAt, d.close, t, sort++));
  }
  if (stmts.length) await env.DB.batch(stmts);
  const champ = g.champion ? ` con ${g.champion}` : '';
  await addFeed(env, 'partida', `${cfg.profile.name} empezó una partida${champ}. ¡Pronósticos abiertos!`);
  return env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(g.id).first();
}

export async function createCustomMarket(env, { question, options, minutes, base, gameId }) {
  const cfg = await getConfig(env);
  const id = randomHex(8);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO markets (id, game_id, kind, grp, question, options, line, base, status, closes_at, created_at, sort)
     VALUES (?, ?, 'custom', 'especial', ?, ?, NULL, ?, 'open', ?, ?, 100)`
  ).bind(id, gameId || null, question, JSON.stringify(options.map((label, i) => ({ key: `o${i + 1}`, label }))),
    base || cfg.economy.base_reward, t + minutes * 60_000, t).run();
  await addFeed(env, 'partida', `Nuevo pronóstico especial: ${question}`);
  return id;
}

// ---------- Picks ----------
export async function placePick(env, user, { market_id, option, boost }) {
  if (user.banned) return { ok: false, error: 'Tu cuenta está suspendida.' };
  const m = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(market_id).first();
  if (!m) return { ok: false, error: 'Ese pronóstico no existe.' };
  if (m.status !== 'open' || now() >= m.closes_at) return { ok: false, error: 'Ese pronóstico ya cerró.' };
  const opts = JSON.parse(m.options);
  if (!opts.some((o) => o.key === option)) return { ok: false, error: 'Opción inválida.' };
  if (boost && !['x2', 'escudo'].includes(boost)) boost = null;

  const existing = await env.DB.prepare('SELECT id FROM picks WHERE market_id = ? AND user_id = ?').bind(market_id, user.id).first();
  if (existing) return { ok: false, error: 'Ya hiciste ese pronóstico.' };

  if (boost && !(await useInventory(env, user.id, boost))) return { ok: false, error: 'No tenés ese comodín.' };

  const dm = decorateMarket(m, await marketCounts(env, market_id));
  const odds = dm.options.find((o) => o.key === option).odds;
  const payout = Math.round(m.base * odds) * (boost === 'x2' ? 2 : 1);
  try {
    await env.DB.prepare('INSERT INTO picks (id, market_id, user_id, option, odds, boost, payout, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(randomHex(8), market_id, user.id, option, odds, boost || null, payout, 'pending', now()).run();
  } catch (e) {
    if (boost) await addInventory(env, user.id, boost, 1);
    return { ok: false, error: 'Ya hiciste ese pronóstico.' };
  }
  return { ok: true, market_id, option, odds, payout, boost: boost || null };
}

export async function buyComodin(env, user, item, qty = 1) {
  const { economy } = await getConfig(env);
  const price = item === 'x2' ? economy.comodin_x2 : item === 'escudo' ? economy.comodin_escudo : null;
  if (!price) return { ok: false, error: 'Comodín inválido.' };
  qty = clamp(parseInt(qty, 10) || 1, 1, 10);
  const label = item === 'x2' ? 'Doble premio' : 'Escudo';
  if (!(await spend(env, user.id, price * qty, `Comodín ${label} x${qty}`))) return { ok: false, error: 'No te alcanzan las fichas.' };
  await addInventory(env, user.id, item, qty);
  return { ok: true };
}

// ---------- Resolución ----------
export async function resolveMarket(env, marketId, outcome, eventEpoch = null) {
  const t = now();
  const m = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(marketId).first();
  if (!m || m.status !== 'open') return false;
  const isVoid = outcome === 'void';
  const upd = await env.DB.prepare(`UPDATE markets SET status = ?, outcome = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
    .bind(isVoid ? 'void' : 'resolved', isVoid ? null : outcome, t, marketId).run();
  if (upd.meta.changes !== 1) return false;

  // Si el evento pasó con el pronóstico todavía abierto, se anulan los picks de los últimos segundos.
  const snipeFrom = eventEpoch && eventEpoch < m.closes_at ? eventEpoch - SNIPE_MS : Number.MAX_SAFE_INTEGER;
  const stmts = [];
  if (isVoid) {
    stmts.push(env.DB.prepare(`UPDATE picks SET status = 'void' WHERE market_id = ? AND status = 'pending'`).bind(marketId));
  } else {
    stmts.push(env.DB.prepare(
      `UPDATE picks SET status = CASE WHEN created_at > ?2 THEN 'void' WHEN option = ?3 THEN 'won' ELSE 'lost' END
       WHERE market_id = ?1 AND status = 'pending'`
    ).bind(marketId, snipeFrom, outcome));
  }
  // Los comodines de los picks anulados se devuelven
  stmts.push(env.DB.prepare(
    `INSERT INTO inventory (user_id, item, qty) SELECT user_id, boost, 1 FROM picks WHERE market_id = ?1 AND boost IS NOT NULL AND status = 'void'
     ON CONFLICT(user_id, item) DO UPDATE SET qty = inventory.qty + 1`
  ).bind(marketId));
  if (!isVoid) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO ledger (user_id, delta, reason, ref, created_at)
       SELECT user_id, payout, 'Pronóstico acertado', 'pick:' || id, ?2 FROM picks WHERE market_id = ?1 AND status = 'won'`
    ).bind(marketId, t));
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO ledger (user_id, delta, reason, ref, created_at)
       SELECT user_id, payout / 2, 'Escudo (pronóstico fallado)', 'pick:' || id, ?2 FROM picks
       WHERE market_id = ?1 AND status = 'lost' AND boost = 'escudo' AND payout >= 2`
    ).bind(marketId, t));
    stmts.push(env.DB.prepare(
      `UPDATE users SET
         balance = (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE user_id = users.id),
         total_won = total_won + COALESCE((SELECT payout FROM picks WHERE market_id = ?1 AND user_id = users.id AND status = 'won'), 0),
         picks_won = picks_won + (SELECT COUNT(*) FROM picks WHERE market_id = ?1 AND user_id = users.id AND status = 'won'),
         picks_total = picks_total + (SELECT COUNT(*) FROM picks WHERE market_id = ?1 AND user_id = users.id AND status IN ('won', 'lost'))
       WHERE id IN (SELECT user_id FROM picks WHERE market_id = ?1)`
    ).bind(marketId));
  }
  await env.DB.batch(stmts);

  if (!isVoid) {
    const opts = JSON.parse(m.options);
    const label = opts.find((o) => o.key === outcome)?.label || outcome;
    const stats = await env.DB.prepare(
      `SELECT SUM(status = 'won') AS won, SUM(status IN ('won','lost')) AS total, COALESCE(SUM(CASE WHEN status = 'won' THEN payout END), 0) AS paid
       FROM picks WHERE market_id = ?`
    ).bind(marketId).first();
    const pct = stats.total ? Math.round((stats.won * 100) / stats.total) : 0;
    if (stats.total) await addFeed(env, 'resultado', `${m.question} → ${label}. Acertó el ${pct}% (${stats.paid} fichas repartidas)`, null, stats.paid);
  }
  return true;
}

async function pendingMarkets(env, gameId) {
  const { results } = await env.DB.prepare(`SELECT * FROM markets WHERE game_id = ? AND status = 'open'`).bind(gameId).all();
  return results;
}

export async function finishGame(env, game, { win, kills, deaths, assists, duration, reason }) {
  const cfg = await getConfig(env);
  const remake = duration != null && duration < 210;
  for (const m of await pendingMarkets(env, game.id)) {
    let out = null;
    if (remake) out = 'void';
    else if (m.kind === 'win' && win != null) out = win ? 'si' : 'no';
    else if (m.kind === 'kills' && kills != null) out = kills > m.line ? 'mas' : 'menos';
    else if (m.kind === 'deaths' && deaths != null) out = deaths > m.line ? 'mas' : 'menos';
    else if (m.kind === 'duration' && duration != null) out = duration > m.line * 60 ? 'si' : 'no';
    else if (m.kind === 'death10' && duration != null) out = 'no'; // si hubiera muerto ya estaría resuelto
    else if (m.kind === 'firstblood' || m.kind === 'firstdragon') out = 'void';
    else if (m.kind === 'custom') continue; // los especiales los resuelve el streamer
    else out = 'void';
    await resolveMarket(env, m.id, out);
  }
  const result = remake ? 'void' : win == null ? 'void' : win ? 'win' : 'loss';
  await env.DB.prepare(
    `UPDATE games SET status = 'ended', result = ?, kills = COALESCE(?, kills), deaths = COALESCE(?, deaths), assists = COALESCE(?, assists),
       game_time = COALESCE(?, game_time), ended_at = ?, updated_at = ? WHERE id = ?`
  ).bind(result, kills ?? null, deaths ?? null, assists ?? null, duration ?? null, now(), now(), game.id).run();
  const champ = game.champion ? ` con ${game.champion}` : '';
  const kda = kills != null ? ` (${kills}/${deaths}/${assists ?? 0})` : '';
  const text = result === 'win' ? `¡Victoria de ${cfg.profile.name}${champ}${kda}!`
    : result === 'loss' ? `Derrota de ${cfg.profile.name}${champ}${kda}.`
    : `Partida anulada${reason ? ` (${reason})` : ''}. Los pronósticos se devolvieron.`;
  await addFeed(env, 'partida', text);
}

export async function voidGame(env, game, reason) {
  for (const m of await pendingMarkets(env, game.id)) {
    if (m.kind !== 'custom') await resolveMarket(env, m.id, 'void');
  }
  await env.DB.prepare(`UPDATE games SET status = 'ended', result = 'void', ended_at = ?, updated_at = ? WHERE id = ?`).bind(now(), now(), game.id).run();
  await addFeed(env, 'partida', `Partida anulada (${reason}). Los pronósticos se devolvieron.`);
}

// ---------- Datos que manda la app de la PC del streamer ----------
function teamOfName(players, name) {
  const n = normName(name);
  if (!n) return null;
  for (const p of players) if ((p.names || []).some((x) => normName(x) === n)) return p.team;
  return null;
}

export async function processAppSync(env, body) {
  const cfg = await getConfig(env);
  const g = body.game;
  if (!g) return { ok: true, game: null };
  if (cfg.markets.ignore_modes.includes(String(g.mode || '').toUpperCase())) return { ok: true, game: null, ignored: 'Modo de juego ignorado (práctica)' };

  const t = now();
  const players = Array.isArray(g.players) ? g.players.slice(0, 12) : [];
  const myNames = new Set((g.active?.names || []).map(normName).filter(Boolean));
  const me = players.find((p) => (p.names || []).some((n) => myNames.has(normName(n)))) || null;
  const startEpoch = Math.round(t - (Number(g.gameTime) || 0) * 1000);
  const id = `app_${String(g.session || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;

  let game = await getLiveGame(env);
  if (game && game.id !== id) {
    if (game.source === 'app' || game.status === 'ending') await voidGame(env, game, 'empezó otra partida');
    game = null;
  }
  if (!game) {
    const existing = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first();
    if (existing) return { ok: true, game: { id, status: existing.status } }; // ya terminó: ignorar los últimos envíos
    game = await createGame(env, {
      id, source: 'app', champion: me?.champion, champion_key: me?.champion_key, team: me?.team,
      game_mode: g.mode, game_time: g.gameTime, start_epoch: startEpoch,
    }, true);
  }

  const team = game.team || me?.team || null;
  const events = (Array.isArray(g.events) ? g.events : [])
    .filter((e) => Number(e.EventID) > game.last_event_id)
    .sort((a, b) => a.EventID - b.EventID);
  let lastId = game.last_event_id;
  let ended = null;

  const open = {};
  for (const m of await pendingMarkets(env, game.id)) open[m.kind] = m;
  const epochOf = (ev) => game.start_epoch + Math.round(Number(ev.EventTime) * 1000);

  for (const ev of events) {
    lastId = Math.max(lastId, Number(ev.EventID));
    switch (ev.EventName) {
      case 'FirstBlood':
        if (open.firstblood) {
          const tm = teamOfName(players, ev.Recipient);
          await resolveMarket(env, open.firstblood.id, tm ? (tm === team ? 'si' : 'no') : 'void', epochOf(ev));
          delete open.firstblood;
        }
        break;
      case 'ChampionKill':
        if (open.death10 && Number(ev.EventTime) < 600 && myNames.has(normName(ev.VictimName))) {
          await resolveMarket(env, open.death10.id, 'si', epochOf(ev));
          delete open.death10;
        }
        break;
      case 'DragonKill':
        if (open.firstdragon) {
          const tm = teamOfName(players, ev.KillerName);
          await resolveMarket(env, open.firstdragon.id, tm ? (tm === team ? 'si' : 'no') : 'void', epochOf(ev));
          delete open.firstdragon;
        }
        break;
      case 'GameEnd':
        ended = { win: String(ev.Result).toLowerCase() === 'win', duration: Number(ev.EventTime) || Number(g.gameTime) };
        break;
    }
  }

  if (open.death10 && Number(g.gameTime) >= 600) await resolveMarket(env, open.death10.id, 'no');

  // El cierre sigue al reloj del juego: si la partida se pausa, los pronósticos esperan.
  await env.DB.prepare(
    `UPDATE markets SET closes_at = ?1 + CAST(close_gt * 1000 AS INTEGER)
     WHERE game_id = ?2 AND status = 'open' AND close_gt IS NOT NULL AND closes_at > ?3`
  ).bind(startEpoch, game.id, t).run();

  await env.DB.prepare(
    `UPDATE games SET status = 'live', champion = COALESCE(?, champion), champion_key = COALESCE(?, champion_key), team = COALESCE(team, ?),
       game_time = ?, start_epoch = ?, kills = ?, deaths = ?, assists = ?, cs = ?, last_event_id = ?, players = ?, updated_at = ? WHERE id = ?`
  ).bind(me?.champion || null, me?.champion_key || null, me?.team || null, Number(g.gameTime) || 0, startEpoch,
    me?.kills ?? game.kills, me?.deaths ?? game.deaths, me?.assists ?? game.assists, me?.cs ?? game.cs, lastId,
    JSON.stringify(players.map((p) => ({ c: p.champion, k: p.champion_key, t: p.team }))), t, game.id).run();

  if (ended) {
    const fresh = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(game.id).first();
    await finishGame(env, fresh, { win: ended.win, kills: me?.kills, deaths: me?.deaths, assists: me?.assists, duration: ended.duration });
    return { ok: true, game: { id: game.id, status: 'ended' } };
  }
  const openCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM markets WHERE game_id = ? AND status = 'open' AND closes_at > ?`).bind(game.id, now()).first();
  return { ok: true, game: { id: game.id, status: 'live', open_markets: openCount.n } };
}
