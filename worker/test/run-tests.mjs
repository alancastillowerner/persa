// Pruebas de punta a punta del Worker con base en memoria y APIs externas simuladas.
// Uso: node --no-warnings worker/test/run-tests.mjs
import { createD1 } from './d1-local.mjs';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(path.join(here, '../src/index.js'))).default;
const { invalidateSettings } = await import(path.join(here, '../src/util.js'));

// Reloj simulado: el tiempo de juego que manda la "app" coincide con el reloj del servidor.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
let T0 = null; // momento en que la partida estaba en el segundo 15
function atGameTime(gt) {
  if (T0 === null) T0 = Date.now() - (gt - 15) * 1000;
  clockOffset += T0 + (gt - 15) * 1000 - Date.now();
}

let pass = 0;
let failCount = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); } else { failCount++; console.log('  ✗', msg); }
}

// ---------- APIs externas simuladas ----------
const external = [];
let riotMode = { spectator: null, matchIds: [], match: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  external.push({ url, method: init.method || 'GET', body: init.body });
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('ddragon.leagueoflegends.com/api/versions.json')) return ok(['16.20.1']);
  if (url.includes('ddragon.leagueoflegends.com') && url.includes('champion.json')) return ok({ data: { Ahri: { key: '103', id: 'Ahri', name: 'Ahri' }, Jinx: { key: '222', id: 'Jinx', name: 'Jinx' } } });
  if (url.includes('/riot/account/v1/accounts/by-riot-id/')) return ok({ puuid: 'PUUID-PERSA', gameName: 'El Persa', tagLine: 'LAS' });
  if (url.includes('/lol/spectator/v5/active-games/by-summoner/')) return riotMode.spectator ? ok(riotMode.spectator) : ok({}, 404);
  if (url.includes('/lol/match/v5/matches/by-puuid/')) return ok(riotMode.matchIds);
  if (url.includes('/lol/match/v5/matches/')) return riotMode.match ? ok(riotMode.match) : ok({}, 404);
  return ok({ data: [] }); // Twitch / Kick: aceptar todo
};

// ---------- Entorno ----------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  DB: createD1(path.join(here, '../schema.sql')),
  DEV_MODE: '1',
  ADMIN_PASSWORD: 'clave-panel',
  TWITCH_EVENTSUB_SECRET: 'secreto-de-eventsub-123',
  TWITCH_CLIENT_ID: 'tw-client', TWITCH_CLIENT_SECRET: 'tw-secret',
  KICK_CLIENT_ID: 'kick-client', KICK_CLIENT_SECRET: 'kick-secret',
  KICK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  RIOT_API_KEY: 'RGAPI-test',
  PUBLIC_URL: 'https://grieta.test',
};
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };

class Client {
  constructor() { this.cookies = {}; }
  async req(method, p, body, headers = {}) {
    const h = new Headers(headers);
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) h.set('cookie', ck);
    if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
    if (method === 'POST' && p.startsWith('/api/') && !p.startsWith('/api/app/')) h.set('x-grieta', '1');
    const res = await worker.fetch(new Request('https://grieta.test' + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' }), env, ctx);
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (c.includes('Max-Age=0')) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
}

const sleepGameTime = (t) => t; // los tiempos de juego se pasan explícitos

function player(name, team, champ, k = 0, d = 0, a = 0) {
  return { names: [name, `${name}#LAS`], team, champion: champ, champion_key: champ, kills: k, deaths: d, assists: a, cs: 10 };
}
const PLAYERS = (k = 0, d = 0, a = 0) => [
  player('El Persa', 'ORDER', 'Ahri', k, d, a), player('Aliado1', 'ORDER', 'Garen'), player('Aliado2', 'ORDER', 'Lux'),
  player('Rival1', 'CHAOS', 'Zed'), player('Rival2', 'CHAOS', 'Jinx'),
];

async function main() {
  const adminC = new Client();
  const app = { key: null };

  console.log('\nPanel y conector');
  let r = await adminC.post('/api/admin/login', { password: 'mal' });
  check(r.status === 401, 'contraseña incorrecta rechazada');
  r = await adminC.post('/api/admin/login', { password: 'clave-panel' });
  check(r.status === 200 && adminC.cookies.aid, 'login del panel');
  r = await adminC.get('/api/admin/overview');
  check(r.data.ok && r.data.config.economy.points_per_ficha === 100, 'overview con 100 puntos por ficha');
  r = await adminC.post('/api/admin/app-key');
  const decoded = JSON.parse(Buffer.from(r.data.code.replace('GRIETA-', ''), 'base64url').toString());
  app.key = decoded.k;
  check(decoded.u === 'https://grieta.test' && app.key.length === 48, 'código de conexión con URL y clave');
  const appReq = (body) => worker.fetch(new Request('https://grieta.test/api/app/sync', {
    method: 'POST', headers: { authorization: `Bearer ${app.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, ctx).then((x) => x.json());
  const bad = await worker.fetch(new Request('https://grieta.test/api/app/sync', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' }), env, ctx);
  check(bad.status === 401, 'conector con clave inválida rechazado');

  console.log('\nRegistro de viewers');
  const ana = new Client();
  const beto = new Client();
  r = await ana.get('/auth/dev?platform=twitch&name=Ana&id=tw_ana');
  check(r.status === 302 && ana.cookies.sid, 'Ana entra con Twitch');
  r = await beto.get('/auth/dev?platform=kick&name=Beto&id=kk_beto');
  check(r.status === 302, 'Beto entra con Kick');
  r = await ana.get('/api/me');
  check(r.data.user.balance === 50, 'bono de bienvenida de 50 fichas');

  console.log('\nCanjes de puntos de canal → fichas');
  const tok = (id) => JSON.stringify({ id, login: 'el_persa', access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 3600_000 });
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('twitch_broadcaster', ?), ('kick_broadcaster', ?)`).bind(tok('100'), tok('200')).run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('twitch_rewards', ?), ('kick_rewards', ?)`)
    .bind(JSON.stringify([{ id: 'tw-r10', fichas: 10, cost: 1000 }, { id: 'tw-r1', fichas: 1, cost: 100 }]), JSON.stringify([{ id: 'kk-r10', fichas: 10, cost: 1000 }])).run();
  invalidateSettings();
  const twBody = (userId, login, redemption, reward = 'tw-r10') => JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: { id: redemption, user_id: userId, user_login: login, user_name: login, reward: { id: reward, cost: 1000 } },
  });
  const twSend = async (body, msgId, secret = env.TWITCH_EVENTSUB_SECRET) => {
    const ts = new Date().toISOString();
    const sig = 'sha256=' + createHmac('sha256', secret).update(msgId + ts + body).digest('hex');
    return worker.fetch(new Request('https://grieta.test/webhooks/twitch', {
      method: 'POST', body,
      headers: { 'Twitch-Eventsub-Message-Id': msgId, 'Twitch-Eventsub-Message-Timestamp': ts, 'Twitch-Eventsub-Message-Signature': sig, 'Twitch-Eventsub-Message-Type': 'notification' },
    }), env, ctx);
  };
  let res = await twSend(twBody('tw_ana', 'ana', 'red-1'), 'msg-1', 'firma-falsa');
  check(res.status === 403, 'webhook de Twitch con firma falsa rechazado');
  res = await twSend(twBody('tw_ana', 'ana', 'red-1'), 'msg-1');
  check(res.status === 204, 'webhook de Twitch válido aceptado');
  await twSend(twBody('tw_ana', 'ana', 'red-1'), 'msg-1'); // reintento de Twitch
  await twSend(twBody('tw_ana', 'ana', 'red-1'), 'msg-1b'); // mismo canje, otro mensaje
  r = await ana.get('/api/me');
  check(r.data.user.balance === 60, 'Ana recibe 10 fichas una sola vez (1000 puntos)');
  const ver = await worker.fetch(new Request('https://grieta.test/webhooks/twitch', {
    method: 'POST', body: JSON.stringify({ challenge: 'abc123' }),
    headers: (() => { const ts = new Date().toISOString(); const b = JSON.stringify({ challenge: 'abc123' }); return { 'Twitch-Eventsub-Message-Id': 'v1', 'Twitch-Eventsub-Message-Timestamp': ts, 'Twitch-Eventsub-Message-Signature': 'sha256=' + createHmac('sha256', env.TWITCH_EVENTSUB_SECRET).update('v1' + ts + b).digest('hex'), 'Twitch-Eventsub-Message-Type': 'webhook_callback_verification' }; })(),
  }), env, ctx);
  check((await ver.text()) === 'abc123', 'verificación de EventSub responde el challenge');
  await Promise.all(waits);
  check(external.some((e) => e.url.includes('custom_rewards/redemptions') && e.method === 'PATCH' && e.body.includes('FULFILLED')), 'el canje se marca como cumplido en Twitch');

  // Kick firmado con RSA
  const kickSend = async (payload, msgId, forge = false) => {
    const body = JSON.stringify(payload);
    const ts = new Date().toISOString();
    const signer = createSign('RSA-SHA256');
    signer.update(`${msgId}.${ts}.${body}`);
    let sig = signer.sign(privateKey, 'base64');
    if (forge) sig = Buffer.from('x'.repeat(256)).toString('base64');
    return worker.fetch(new Request('https://grieta.test/webhooks/kick', {
      method: 'POST', body,
      headers: { 'Kick-Event-Message-Id': msgId, 'Kick-Event-Message-Timestamp': ts, 'Kick-Event-Signature': sig, 'Kick-Event-Type': 'channel.reward.redemption.updated', 'Kick-Event-Version': '1' },
    }), env, ctx);
  };
  const kickEv = (status, rid = 'kred-1') => ({ id: rid, status, user_input: '', redeemed_at: new Date().toISOString(), reward: { id: 'kk-r10', title: 'Cargar 10 fichas', cost: 1000 }, redeemer: { user_id: 'kk_beto', username: 'Beto', channel_slug: 'beto' }, broadcaster: { user_id: 1, username: 'El_Persa', channel_slug: 'el_persa' } });
  res = await kickSend(kickEv('pending'), 'k-1', true);
  check(res.status === 403, 'webhook de Kick con firma falsa rechazado');
  res = await kickSend(kickEv('pending'), 'k-1');
  check(res.status === 200, 'webhook de Kick válido aceptado');
  await kickSend(kickEv('accepted'), 'k-2'); // Kick avisa de nuevo cuando lo aceptamos
  r = await beto.get('/api/me');
  check(r.data.user.balance === 60, 'Beto recibe 10 fichas una sola vez');
  await Promise.all(waits);
  check(external.filter((e) => e.url.includes('/redemptions/accept')).length === 1, 'el canje se acepta en Kick (una sola vez)');

  // Alguien canjea antes de registrarse
  await twSend(twBody('tw_caro', 'caro', 'red-2'), 'msg-2');
  await twSend(twBody('tw_caro', 'caro', 'red-3', 'tw-r1'), 'msg-3');
  const caro = new Client();
  await caro.get('/auth/dev?platform=twitch&name=Caro&id=tw_caro');
  r = await caro.get('/api/me');
  check(r.data.user.balance === 61, 'Caro recibe al registrarse los canjes previos (50 + 10 + 1)');

  console.log('\nPartida con la app de PC');
  let s = await appReq({ version: 'test', game: null });
  check(s.ok && s.game === null, 'latido sin partida');
  atGameTime(15);
  s = await appReq({ version: 'test', game: { session: 'abc123', gameTime: 15, mode: 'CLASSIC', active: { names: ['El Persa#LAS'] }, players: PLAYERS(), events: [{ EventID: 0, EventName: 'GameStart', EventTime: 0.05 }] } });
  check(s.game && s.game.status === 'live' && s.game.open_markets === 7, `partida creada con 7 pronósticos (${s.game?.open_markets})`);
  r = await ana.get('/api/state');
  const mk = Object.fromEntries(r.data.markets.map((m) => [m.kind, m]));
  check(mk.win && mk.win.options[0].odds === 1.8, 'cuota inicial 1.80');
  check(r.data.game.champion === 'Ahri', 'campeón detectado');

  r = await ana.post('/api/buy', { item: 'x2' });
  check(r.data.ok, 'Ana compra comodín Doble premio (25)');
  r = await ana.post('/api/picks', { picks: [
    { market_id: mk.win.id, option: 'si', boost: 'x2' },
    { market_id: mk.kills.id, option: 'mas' },
    { market_id: mk.firstblood.id, option: 'si' },
    { market_id: mk.death10.id, option: 'no' },
  ] });
  check(r.data.results.every((x) => x.ok), 'Ana hace 4 pronósticos');
  check(r.data.results[0].payout === 36, `premio con x2 = 10 × 1.80 × 2 = 36 (${r.data.results[0].payout})`);
  r = await ana.post('/api/picks', { market_id: mk.win.id, option: 'no' });
  check(!r.data.ok, 'no se puede pronosticar dos veces lo mismo');
  r = await beto.post('/api/picks', { picks: [{ market_id: mk.win.id, option: 'no' }, { market_id: mk.firstblood.id, option: 'no' }, { market_id: mk.death10.id, option: 'si' }, { market_id: mk.duration.id, option: 'si', boost: 'escudo' }] });
  check(r.data.results[3].ok === false, 'Beto no puede usar un escudo que no compró');
  check(r.data.results.slice(0, 3).every((x) => x.ok), 'Beto hace 3 pronósticos');
  atGameTime(45);
  r = await caro.post('/api/picks', { picks: [{ market_id: mk.win.id, option: 'si' }, { market_id: mk.firstblood.id, option: 'si' }] });
  check(r.data.results.every((x) => x.ok), 'Caro pronostica en el segundo 45');
  r = await caro.get('/api/state');
  const w = r.data.markets.find((m) => m.kind === 'win').options;
  check(w[0].odds < w[1].odds, `la opción más elegida paga menos (${w[0].odds} vs ${w[1].odds})`);

  // Primera sangre de un aliado en el segundo 50
  atGameTime(75);
  s = await appReq({ version: 'test', game: { session: 'abc123', gameTime: 75, mode: 'CLASSIC', active: { names: ['El Persa'] }, players: PLAYERS(),
    events: [{ EventID: 0, EventName: 'GameStart', EventTime: 0.05 }, { EventID: 1, EventName: 'FirstBlood', EventTime: 50, Recipient: 'Aliado1' }, { EventID: 2, EventName: 'ChampionKill', EventTime: 50, KillerName: 'Aliado1', VictimName: 'Rival1' }] } });
  r = await ana.get('/api/me');
  check(r.data.picks.find((p) => p.market_id === mk.firstblood.id).status === 'won', 'Ana acierta la primera sangre (pick hecho con tiempo)');
  r = await caro.get('/api/me');
  check(r.data.picks.find((p) => p.market_id === mk.firstblood.id).status === 'void', 'pick de Caro 5 s antes del evento → anulado (anti-delay)');
  r = await beto.get('/api/me');
  const betoBefore = r.data.user.balance;

  // El Persa muere a los 5 minutos
  atGameTime(310);
  s = await appReq({ version: 'test', game: { session: 'abc123', gameTime: 310, mode: 'CLASSIC', active: { names: ['El Persa'] }, players: PLAYERS(1, 1, 0),
    events: [{ EventID: 3, EventName: 'ChampionKill', EventTime: 300, KillerName: 'Rival1', VictimName: 'El Persa' }] } });
  r = await beto.get('/api/me');
  const d10 = r.data.picks.find((p) => p.market_id === mk.death10.id);
  check(d10.status === 'won', 'Beto acierta "muere antes del 10"');
  check(r.data.user.balance === betoBefore + d10.payout, `Beto cobra ${d10.payout} fichas (cuota ${d10.odds})`);
  r = await ana.post('/api/picks', { market_id: mk.deaths.id, option: 'mas' });
  check(!r.data.ok, 'pronósticos de partida cerrados después del minuto 4');

  // Dragón para el rival y final de partida
  atGameTime(1900);
  s = await appReq({ version: 'test', game: { session: 'abc123', gameTime: 1900, mode: 'CLASSIC', active: { names: ['El Persa'] }, players: PLAYERS(8, 3, 6),
    events: [{ EventID: 4, EventName: 'DragonKill', EventTime: 400, KillerName: 'Rival2', DragonType: 'Fire' }, { EventID: 5, EventName: 'GameEnd', EventTime: 1890, Result: 'Win' }] } });
  check(s.game.status === 'ended', 'GameEnd termina la partida');
  r = await ana.get('/api/me');
  const st = Object.fromEntries(r.data.picks.map((p) => [p.market_id, p.status]));
  check(st[mk.win.id] === 'won' && st[mk.kills.id] === 'won', 'Ana acierta victoria y más de 5.5 kills');
  const payoutOf = (id) => r.data.picks.find((p) => p.market_id === id).payout;
  const anaExpected = 60 - 25 + payoutOf(mk.win.id) + payoutOf(mk.kills.id) + payoutOf(mk.firstblood.id);
  check(r.data.user.balance === anaExpected, `saldo de Ana correcto (${r.data.user.balance} = ${anaExpected})`);
  r = await ana.get('/api/state');
  check(r.data.game === null && r.data.last_games[0].result === 'win', 'historial muestra la victoria');
  check(r.data.leaderboard[0].name === 'Ana', 'Ana lidera el ranking del mes');
  check(r.data.feed.some((f) => f.kind === 'resultado'), 'el feed anuncia resultados');
  s = await appReq({ version: 'test', game: { session: 'abc123', gameTime: 1905, mode: 'CLASSIC', active: { names: ['El Persa'] }, players: PLAYERS(8, 3, 6), events: [] } });
  check(s.game.status === 'ended', 'envíos tardíos de una partida terminada se ignoran');
  s = await appReq({ version: 'test', game: { session: 'prac1', gameTime: 30, mode: 'PRACTICETOOL', active: { names: ['El Persa'] }, players: PLAYERS(), events: [] } });
  check(s.ignored, 'herramienta de práctica ignorada');

  console.log('\nTienda y canjes');
  r = await ana.get('/api/state');
  const saludo = r.data.rewards.find((x) => x.id === 'saludo');
  check(r.data.rewards.length === 7, '7 premios genéricos cargados');
  r = await ana.post('/api/redeem', { reward_id: 'saludo' });
  check(!r.data.ok, 'no alcanza para el saludo (300)');
  await adminC.post('/api/admin/users', { id: (await ana.get('/api/me')).data.user.id, delta: 400, reason: 'Regalo', announce: true });
  r = await ana.post('/api/redeem', { reward_id: 'campeon' });
  check(!r.data.ok && r.data.error.includes('campeón'), 'el premio "Elegís el campeón" pide el dato');
  r = await ana.post('/api/redeem', { reward_id: 'saludo' });
  check(r.data.ok, 'Ana canjea el saludo');
  r = await adminC.get('/api/admin/orders');
  check(r.data.orders.length === 1 && r.data.orders[0].user_name === 'Ana', 'el canje aparece en el panel');
  const before = (await ana.get('/api/me')).data.user.balance;
  await adminC.post('/api/admin/orders', { id: r.data.orders[0].id, status: 'devuelto' });
  check((await ana.get('/api/me')).data.user.balance === before + saludo.cost, 'devolver un canje reintegra las fichas');

  console.log('\nPronóstico especial del streamer');
  r = await adminC.post('/api/admin/market', { action: 'create', question: '¿Hace pentakill hoy?', options: ['Sí', 'No'], minutes: 5 });
  check(r.data.ok, 'pronóstico especial creado');
  const customId = r.data.id;
  await ana.post('/api/picks', { market_id: customId, option: 'o1' });
  await beto.post('/api/picks', { market_id: customId, option: 'o2' });
  await new Promise((x) => setTimeout(x, 5));
  r = await adminC.post('/api/admin/market', { action: 'resolve', id: customId, outcome: 'o2' });
  check(r.data.ok, 'el streamer lo resuelve');
  r = await beto.get('/api/me');
  check(r.data.picks.find((p) => p.market_id === customId).status === 'won', 'Beto gana el especial');

  console.log('\nVincular cuentas');
  r = await ana.get('/auth/dev?platform=kick&name=Ana&id=kk_ana&mode=link');
  r = await ana.get('/api/me');
  check(r.data.user.twitch === 'ana' && r.data.user.kick === 'ana', 'Ana vincula Twitch y Kick en la misma cuenta');

  console.log('\nModo solo web (API de Riot)');
  await adminC.post('/api/admin/settings', { riot: { game_name: 'El Persa', tag_line: 'LAS', platform: 'la2' } });
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'app_status'`).bind(JSON.stringify({ last: Date.now() - 600_000 })).run();
  riotMode.spectator = { gameId: 555, gameMode: 'CLASSIC', gameQueueConfigId: 420, gameStartTime: Date.now() - 20_000, gameLength: 20, participants: [{ puuid: 'PUUID-PERSA', championId: 222, teamId: 100 }] };
  await worker.scheduled({}, env, ctx);
  await Promise.all(waits);
  r = await ana.get('/api/state');
  check(r.data.game && r.data.game.source === 'riot' && r.data.game.champion === 'Jinx', 'partida detectada por Riot (Jinx)');
  check(r.data.markets.filter((m) => m.status === 'open').length === 4, 'solo los 4 pronósticos de partida (sin app)');
  const rw = r.data.markets.find((m) => m.kind === 'win');
  await beto.post('/api/picks', { market_id: rw.id, option: 'no' });
  riotMode.spectator = null;
  riotMode.match = { info: { gameEndTimestamp: Date.now(), gameDuration: 1500, participants: [{ puuid: 'PUUID-PERSA', win: false, kills: 2, deaths: 7, assists: 4 }] } };
  await worker.scheduled({}, env, ctx);
  await Promise.all(waits);
  r = await beto.get('/api/me');
  check(r.data.picks.find((p) => p.market_id === rw.id).status === 'won', 'Match-V5 resuelve la derrota y Beto acierta');

  console.log('\nSeguridad');
  const evil = await worker.fetch(new Request('https://grieta.test/api/picks', { method: 'POST', headers: { cookie: `sid=${ana.cookies.sid}`, 'content-type': 'text/plain' }, body: '{}' }), env, ctx);
  check(evil.status === 403, 'POST sin header propio (CSRF) bloqueado');
  r = await new Client().get('/api/admin/overview');
  check(r.status === 401, 'panel sin sesión bloqueado');

  console.log(`\n${pass} OK, ${failCount} con error\n`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
