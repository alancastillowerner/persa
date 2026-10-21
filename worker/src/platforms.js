// Llamadas a las APIs de Twitch y Kick: tokens, recompensas de puntos de canal y suscripciones a eventos.
import { now, getSetting, setSetting } from './util.js';
import { getConfig } from './config.js';

const TWITCH_ID = 'https://id.twitch.tv/oauth2';
const TWITCH_API = 'https://api.twitch.tv/helix';
const KICK_ID = 'https://id.kick.com';
const KICK_API = 'https://api.kick.com/public/v1';

export const PLATFORM = {
  twitch: {
    authorize: `${TWITCH_ID}/authorize`,
    viewerScopes: '',
    broadcasterScopes: 'channel:read:redemptions channel:manage:redemptions',
  },
  kick: {
    authorize: `${KICK_ID}/oauth/authorize`,
    viewerScopes: 'user:read',
    broadcasterScopes: 'user:read channel:read channel:rewards:read channel:rewards:write events:subscribe',
  },
};

// ---------- OAuth ----------
export async function exchangeCode(env, platform, code, redirectUri, verifier) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  let url;
  if (platform === 'twitch') {
    url = `${TWITCH_ID}/token`;
    body.set('client_id', env.TWITCH_CLIENT_ID);
    body.set('client_secret', env.TWITCH_CLIENT_SECRET);
  } else {
    url = `${KICK_ID}/oauth/token`;
    body.set('client_id', env.KICK_CLIENT_ID);
    body.set('client_secret', env.KICK_CLIENT_SECRET);
    body.set('code_verifier', verifier);
  }
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`No se pudo validar el inicio de sesión (${platform} ${res.status})`);
  const t = await res.json();
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + (Number(t.expires_in) || 3600) * 1000 };
}

export async function fetchProfile(env, platform, accessToken) {
  if (platform === 'twitch') {
    const res = await fetch(`${TWITCH_API}/users`, { headers: { authorization: `Bearer ${accessToken}`, 'client-id': env.TWITCH_CLIENT_ID } });
    if (!res.ok) throw new Error(`Twitch users ${res.status}`);
    const u = (await res.json()).data[0];
    return { id: String(u.id), login: u.login, name: u.display_name || u.login, avatar: u.profile_image_url };
  }
  const res = await fetch(`${KICK_API}/users`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Kick users ${res.status}`);
  const u = (await res.json()).data[0];
  return { id: String(u.user_id), login: u.name, name: u.name, avatar: u.profile_picture || null };
}

async function refresh(env, platform, tok) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  const url = platform === 'twitch' ? `${TWITCH_ID}/token` : `${KICK_ID}/oauth/token`;
  body.set('client_id', platform === 'twitch' ? env.TWITCH_CLIENT_ID : env.KICK_CLIENT_ID);
  body.set('client_secret', platform === 'twitch' ? env.TWITCH_CLIENT_SECRET : env.KICK_CLIENT_SECRET);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`No se pudo renovar el acceso de ${platform} (${res.status}). Volvé a conectar el canal desde el panel.`);
  const t = await res.json();
  return { ...tok, access_token: t.access_token, refresh_token: t.refresh_token || tok.refresh_token, expires_at: now() + (Number(t.expires_in) || 3600) * 1000 };
}

// Token del canal del streamer (guardado al conectar desde el panel)
export async function broadcasterToken(env, platform) {
  let tok = await getSetting(env, `${platform}_broadcaster`, null);
  if (!tok) throw new Error(`El canal de ${platform === 'twitch' ? 'Twitch' : 'Kick'} no está conectado.`);
  if (tok.expires_at < now() + 60_000) {
    tok = await refresh(env, platform, tok);
    await setSetting(env, `${platform}_broadcaster`, tok);
  }
  return tok;
}

async function twitchAppToken(env) {
  let t = await getSetting(env, 'twitch_app_token', null);
  if (t && t.expires_at > now() + 60_000) return t.access_token;
  const body = new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' });
  const res = await fetch(`${TWITCH_ID}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`Twitch app token ${res.status}`);
  const j = await res.json();
  t = { access_token: j.access_token, expires_at: now() + j.expires_in * 1000 };
  await setSetting(env, 'twitch_app_token', t);
  return t.access_token;
}

// ---------- Recompensas de puntos de canal (100 puntos = 1 ficha) ----------
function packTitle(fichas) {
  return fichas === 1 ? 'Cargar 1 ficha' : `Cargar ${fichas} fichas`;
}

function packDescription(cfg, base) {
  return `Se suman a tu cuenta en ${base.replace(/^https?:\/\//, '')}. Entrá con esta misma cuenta para usarlas.`.slice(0, 200);
}

export async function setupTwitch(env, base) {
  const cfg = await getConfig(env);
  const tok = await broadcasterToken(env, 'twitch');
  const h = { authorization: `Bearer ${tok.access_token}`, 'client-id': env.TWITCH_CLIENT_ID, 'content-type': 'application/json' };
  const existing = (await getSetting(env, 'twitch_rewards', [])) || [];
  const out = [];
  const log = [];
  for (const fichas of cfg.economy.packs) {
    const cost = fichas * cfg.economy.points_per_ficha;
    const payload = { title: packTitle(fichas), cost, prompt: packDescription(cfg, base), is_enabled: true, background_color: '#C8AA6E', should_redemptions_skip_request_queue: false };
    const prev = existing.find((r) => r.fichas === fichas);
    let res;
    if (prev) {
      res = await fetch(`${TWITCH_API}/channel_points/custom_rewards?broadcaster_id=${tok.id}&id=${prev.id}`, { method: 'PATCH', headers: h, body: JSON.stringify(payload) });
      if (res.status === 404) res = null;
    }
    if (!res) res = await fetch(`${TWITCH_API}/channel_points/custom_rewards?broadcaster_id=${tok.id}`, { method: 'POST', headers: h, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.push(`No se pudo crear "${payload.title}": ${j.message || res.status}`);
      continue;
    }
    out.push({ id: j.data[0].id, fichas, cost });
    log.push(`Recompensa "${payload.title}" lista (${cost} puntos)`);
  }
  // Recompensas viejas que ya no están en la lista de packs: se borran
  for (const r of existing) {
    if (!out.some((o) => o.id === r.id)) {
      await fetch(`${TWITCH_API}/channel_points/custom_rewards?broadcaster_id=${tok.id}&id=${r.id}`, { method: 'DELETE', headers: h });
    }
  }
  await setSetting(env, 'twitch_rewards', out);

  // Suscripción EventSub (webhook) a los canjes
  const appTok = await twitchAppToken(env);
  const ah = { authorization: `Bearer ${appTok}`, 'client-id': env.TWITCH_CLIENT_ID, 'content-type': 'application/json' };
  const list = await (await fetch(`${TWITCH_API}/eventsub/subscriptions?type=channel.channel_points_custom_reward_redemption.add`, { headers: ah })).json();
  for (const s of list.data || []) {
    if (s.condition?.broadcaster_user_id === tok.id && (s.status !== 'enabled' || s.transport?.callback !== `${base}/webhooks/twitch`)) {
      await fetch(`${TWITCH_API}/eventsub/subscriptions?id=${s.id}`, { method: 'DELETE', headers: ah });
    }
  }
  const already = (list.data || []).some((s) => s.condition?.broadcaster_user_id === tok.id && s.status === 'enabled' && s.transport?.callback === `${base}/webhooks/twitch`);
  if (!already) {
    const res = await fetch(`${TWITCH_API}/eventsub/subscriptions`, {
      method: 'POST', headers: ah,
      body: JSON.stringify({
        type: 'channel.channel_points_custom_reward_redemption.add', version: '1',
        condition: { broadcaster_user_id: tok.id },
        transport: { method: 'webhook', callback: `${base}/webhooks/twitch`, secret: env.TWITCH_EVENTSUB_SECRET },
      }),
    });
    const j = await res.json().catch(() => ({}));
    log.push(res.ok ? 'Suscripción a canjes de Twitch creada (Twitch la verifica en unos segundos)' : `Error al suscribirse a canjes de Twitch: ${j.message || res.status}`);
  } else {
    log.push('La suscripción a canjes de Twitch ya estaba activa');
  }
  return { rewards: out, log };
}

export async function setupKick(env, base) {
  const cfg = await getConfig(env);
  const tok = await broadcasterToken(env, 'kick');
  const h = { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' };
  const existing = (await getSetting(env, 'kick_rewards', [])) || [];
  const out = [];
  const log = [];
  for (const fichas of cfg.economy.packs) {
    const cost = fichas * cfg.economy.points_per_ficha;
    const payload = { title: packTitle(fichas), cost, description: packDescription(cfg, base), background_color: '#C8AA6E', is_enabled: true, should_redemptions_skip_request_queue: false };
    const prev = existing.find((r) => r.fichas === fichas);
    let res;
    if (prev) {
      res = await fetch(`${KICK_API}/channels/rewards/${prev.id}`, { method: 'PATCH', headers: h, body: JSON.stringify(payload) });
      if (res.status === 404) res = null;
    }
    if (!res) res = await fetch(`${KICK_API}/channels/rewards`, { method: 'POST', headers: h, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.push(`No se pudo crear "${payload.title}": ${j.message || res.status}`);
      continue;
    }
    out.push({ id: j.data.id, fichas, cost });
    log.push(`Recompensa "${payload.title}" lista (${cost} puntos)`);
  }
  for (const r of existing) {
    if (!out.some((o) => o.id === r.id)) await fetch(`${KICK_API}/channels/rewards/${r.id}`, { method: 'DELETE', headers: h });
  }
  await setSetting(env, 'kick_rewards', out);

  const res = await fetch(`${KICK_API}/events/subscriptions`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ events: [{ name: 'channel.reward.redemption.updated', version: 1 }], method: 'webhook' }),
  });
  const j = await res.json().catch(() => ({}));
  const sub = (j.data || [])[0];
  if (res.ok && sub && !sub.error) log.push('Suscripción a canjes de Kick activa');
  else log.push(`Suscripción a canjes de Kick: ${sub?.error || j.message || res.status}. Revisá que el webhook esté activado en la app de Kick.`);
  return { rewards: out, log };
}

// ---------- Marcar el canje como cumplido en la plataforma ----------
export async function completeRedemption(env, platform, redemptionId, rewardId, ok = true) {
  try {
    const tok = await broadcasterToken(env, platform);
    if (platform === 'twitch') {
      await fetch(`${TWITCH_API}/channel_points/custom_rewards/redemptions?broadcaster_id=${tok.id}&reward_id=${rewardId}&id=${redemptionId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${tok.access_token}`, 'client-id': env.TWITCH_CLIENT_ID, 'content-type': 'application/json' },
        body: JSON.stringify({ status: ok ? 'FULFILLED' : 'CANCELED' }),
      });
    } else {
      await fetch(`${KICK_API}/channels/rewards/redemptions/${ok ? 'accept' : 'reject'}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [redemptionId] }),
      });
    }
  } catch (e) {
    console.log('completeRedemption', platform, e.message);
  }
}
