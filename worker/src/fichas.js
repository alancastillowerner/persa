// Movimientos de fichas. Todo pasa por el ledger: el saldo es siempre la suma de sus filas.
import { now, randomHex, addFeed } from './util.js';
import { getConfig } from './config.js';

const RECALC = 'UPDATE users SET balance = (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE user_id = ?1) WHERE id = ?1';

// Acredita (o descuenta, si delta < 0) sin condiciones. `ref` hace que repetir la misma operación no duplique.
export async function credit(env, userId, delta, reason, ref = null) {
  const res = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, delta, reason, ref, now()),
    env.DB.prepare(RECALC).bind(userId),
  ]);
  return res[0].meta.changes === 1;
}

// Descuenta solo si alcanza el saldo. Devuelve true si se pudo.
export async function spend(env, userId, amount, reason, ref = null) {
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ledger (user_id, delta, reason, ref, created_at)
       SELECT ?1, -?2, ?3, ?4, ?5
       WHERE (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE user_id = ?1) >= ?2`
    ).bind(userId, amount, reason, ref || `spend:${randomHex(8)}`, now()),
    env.DB.prepare(RECALC).bind(userId),
  ]);
  return res[0].meta.changes === 1;
}

export async function getUser(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export async function findByPlatform(env, platform, platformId) {
  const col = platform === 'twitch' ? 'twitch_id' : 'kick_id';
  return env.DB.prepare(`SELECT * FROM users WHERE ${col} = ?`).bind(String(platformId)).first();
}

// Crea el usuario la primera vez que entra, le da el bono de bienvenida y le acredita canjes previos.
export async function createUser(env, platform, info) {
  const id = randomHex(10);
  const t = now();
  if (platform === 'twitch') {
    await env.DB.prepare('INSERT INTO users (id, name, avatar, twitch_id, twitch_login, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, info.name, info.avatar, String(info.id), info.login, t).run();
  } else {
    await env.DB.prepare('INSERT INTO users (id, name, avatar, kick_id, kick_username, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, info.name, info.avatar, String(info.id), info.login, t).run();
  }
  const { economy } = await getConfig(env);
  if (economy.welcome_bonus > 0) await credit(env, id, economy.welcome_bonus, 'Bono de bienvenida', `welcome:${id}`);
  await claimPending(env, id, platform, info.id);
  await addFeed(env, 'registro', `${info.name} se sumó a la Grieta`, info.name, null);
  return getUser(env, id);
}

export async function claimPending(env, userId, platform, platformId) {
  const { results } = await env.DB.prepare('SELECT * FROM pending_credits WHERE platform = ? AND platform_user_id = ? AND claimed_by IS NULL')
    .bind(platform, String(platformId)).all();
  for (const p of results) {
    await credit(env, userId, p.fichas, `Canje de puntos (${platform === 'twitch' ? 'Twitch' : 'Kick'})`, p.ref);
    await env.DB.prepare('UPDATE pending_credits SET claimed_by = ? WHERE ref = ?').bind(userId, p.ref).run();
  }
  return results.length;
}

// Une dos cuentas (cuando alguien vincula Twitch y Kick que ya tenían cuentas separadas).
export async function mergeUsers(env, keepId, dropId) {
  if (keepId === dropId) return;
  const drop = await getUser(env, dropId);
  if (!drop) return;
  await env.DB.batch([
    env.DB.prepare('UPDATE ledger SET user_id = ? WHERE user_id = ? AND (ref IS NULL OR ref NOT LIKE ?)').bind(keepId, dropId, 'welcome:%'),
    env.DB.prepare('DELETE FROM ledger WHERE user_id = ?').bind(dropId),
    env.DB.prepare('DELETE FROM picks WHERE user_id = ?1 AND market_id IN (SELECT market_id FROM picks WHERE user_id = ?2)').bind(dropId, keepId),
    env.DB.prepare('UPDATE picks SET user_id = ? WHERE user_id = ?').bind(keepId, dropId),
    env.DB.prepare('UPDATE orders SET user_id = ? WHERE user_id = ?').bind(keepId, dropId),
    env.DB.prepare(
      `INSERT INTO inventory (user_id, item, qty) SELECT ?1, item, qty FROM inventory WHERE user_id = ?2
       ON CONFLICT(user_id, item) DO UPDATE SET qty = inventory.qty + excluded.qty`
    ).bind(keepId, dropId),
    env.DB.prepare('DELETE FROM inventory WHERE user_id = ?').bind(dropId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(dropId),
    env.DB.prepare('UPDATE users SET total_won = total_won + ?2, picks_won = picks_won + ?3, picks_total = picks_total + ?4 WHERE id = ?1')
      .bind(keepId, drop.total_won, drop.picks_won, drop.picks_total),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(dropId),
    env.DB.prepare(RECALC).bind(keepId),
  ]);
}

export async function getInventory(env, userId) {
  const { results } = await env.DB.prepare('SELECT item, qty FROM inventory WHERE user_id = ?').bind(userId).all();
  const inv = { x2: 0, escudo: 0 };
  for (const r of results) inv[r.item] = r.qty;
  return inv;
}

export async function addInventory(env, userId, item, qty) {
  await env.DB.prepare(
    `INSERT INTO inventory (user_id, item, qty) VALUES (?, ?, ?)
     ON CONFLICT(user_id, item) DO UPDATE SET qty = inventory.qty + excluded.qty`
  ).bind(userId, item, qty).run();
}

export async function useInventory(env, userId, item) {
  const r = await env.DB.prepare('UPDATE inventory SET qty = qty - 1 WHERE user_id = ? AND item = ? AND qty > 0').bind(userId, item).run();
  return r.meta.changes === 1;
}
