// Modo "solo web": detecta partidas con la API de Riot (sin la app de la PC) y las resuelve con Match-V5.
import { now, getSetting, setSetting } from './util.js';
import { getConfig } from './config.js';
import { getLiveGame, createGame, finishGame, voidGame } from './markets.js';

async function riotGet(env, host, path) {
  const res = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { 'X-Riot-Token': env.RIOT_API_KEY } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Riot ${res.status} en ${path}`);
  return res.json();
}

async function ddragon(env) {
  let dd = await getSetting(env, 'ddragon', null);
  if (dd && dd.fetched > now() - 24 * 3600_000) return dd;
  const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
  const version = versions[0];
  const champs = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/es_AR/champion.json`)).json();
  const byId = {};
  for (const c of Object.values(champs.data)) byId[c.key] = { key: c.id, name: c.name };
  dd = { version, byId, fetched: now() };
  await setSetting(env, 'ddragon', dd);
  return dd;
}

export async function ensureDdragonVersion(env) {
  try {
    return (await ddragon(env)).version;
  } catch {
    return null;
  }
}

export async function resolvePuuid(env, riot) {
  if (riot.puuid) return riot.puuid;
  const acc = await riotGet(env, riot.region, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riot.game_name)}/${encodeURIComponent(riot.tag_line)}`);
  if (!acc) throw new Error('No encontré esa cuenta de Riot. Revisá el nombre y el tag.');
  riot.puuid = acc.puuid;
  const stored = await getSetting(env, 'riot', {});
  await setSetting(env, 'riot', { ...stored, puuid: acc.puuid });
  return acc.puuid;
}

async function findMatchResult(env, riot, puuid, game) {
  let matchId = game.match_id;
  if (!matchId) {
    const ids = await riotGet(env, riot.region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=3&startTime=${Math.floor(game.created_at / 1000) - 600}`);
    if (!ids || !ids.length) return null;
    matchId = ids[0];
  }
  const match = await riotGet(env, riot.region, `/lol/match/v5/matches/${matchId}`);
  if (!match || !match.info || !match.info.gameEndTimestamp) return null;
  const p = match.info.participants.find((x) => x.puuid === puuid);
  if (!p) return null;
  return { win: !!p.win, kills: p.kills, deaths: p.deaths, assists: p.assists, duration: match.info.gameDuration };
}

export async function riotTick(env) {
  const { riot } = await getConfig(env);
  const app = await getSetting(env, 'app_status', null);
  const appAlive = app && now() - app.last < 90_000;
  const live = await getLiveGame(env);

  // Partidas de la app que se quedaron sin datos (la app se cerró a mitad de partida)
  if (live && live.source === 'app' && now() - live.updated_at > 180_000) {
    if (live.status === 'live') await env.DB.prepare(`UPDATE games SET status = 'ending' WHERE id = ?`).bind(live.id).run();
    if (env.RIOT_API_KEY && riot.game_name) {
      try {
        const puuid = await resolvePuuid(env, riot);
        const r = await findMatchResult(env, riot, puuid, live);
        if (r) return finishGame(env, live, r);
      } catch (e) {
        console.log('riot fallback', e.message);
      }
    }
    if (now() - live.updated_at > 20 * 60_000) await voidGame(env, live, 'se perdió la conexión con la app');
    return;
  }

  if (!env.RIOT_API_KEY || !riot.game_name || !riot.tag_line) return;
  if (appAlive && (!live || live.source === 'app')) return; // la app manda: no hace falta consultar a Riot

  const puuid = await resolvePuuid(env, riot);
  const sp = await riotGet(env, riot.platform, `/lol/spectator/v5/active-games/by-summoner/${puuid}`);

  if (sp) {
    const id = `riot_${riot.platform.toUpperCase()}_${sp.gameId}`;
    if (live && live.id === id) {
      await env.DB.prepare('UPDATE games SET game_time = ?, updated_at = ? WHERE id = ?').bind(sp.gameLength || 0, now(), id).run();
      return;
    }
    if (live) await voidGame(env, live, 'empezó otra partida');
    if (sp.gameQueueConfigId === 0 && !riot.allow_custom) return; // partidas personalizadas: se ignoran
    let champ = null;
    try {
      const dd = await ddragon(env);
      const me = sp.participants.find((p) => p.puuid === puuid);
      if (me) champ = dd.byId[String(me.championId)];
    } catch { /* sin nombre de campeón */ }
    const me = sp.participants.find((p) => p.puuid === puuid);
    await createGame(env, {
      id, source: 'riot', champion: champ?.name, champion_key: champ?.key,
      team: me ? (me.teamId === 100 ? 'ORDER' : 'CHAOS') : null, game_mode: sp.gameMode,
      game_time: sp.gameLength || 0,
      start_epoch: sp.gameStartTime > 0 ? sp.gameStartTime : now(),
    }, false);
    await env.DB.prepare('UPDATE games SET match_id = ? WHERE id = ?').bind(`${riot.platform.toUpperCase()}_${sp.gameId}`, id).run();
    return;
  }

  // No hay partida en curso: si teníamos una de Riot, ya terminó → buscar el resultado
  if (live && live.source === 'riot') {
    if (live.status === 'live') await env.DB.prepare(`UPDATE games SET status = 'ending', updated_at = ? WHERE id = ?`).bind(now(), live.id).run();
    const r = await findMatchResult(env, riot, puuid, live);
    if (r) return finishGame(env, live, r);
    if (now() - live.updated_at > 20 * 60_000) await voidGame(env, live, 'Riot no publicó el resultado');
  }
}
