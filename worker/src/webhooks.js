// Webhooks: Twitch EventSub y Kick. Cada canje de puntos de canal se convierte en fichas.
import { now, hmacHex, safeEqual, getSetting, setSetting, addFeed } from './util.js';
import { credit, findByPlatform } from './fichas.js';
import { completeRedemption } from './platforms.js';

async function alreadySeen(env, id) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO seen_messages (id, created_at) VALUES (?, ?)').bind(id, now()).run();
  return r.meta.changes === 0;
}

export async function handleRedemption(env, ctx, { platform, redemptionId, rewardId, platformUserId, login, displayName, complete = true }) {
  const rewards = (await getSetting(env, `${platform}_rewards`, [])) || [];
  const pack = rewards.find((r) => r.id === rewardId);
  if (!pack) return { ok: true, ignored: 'no es una recompensa de fichas' };

  const ref = `${platform}:${redemptionId}`;
  const user = await findByPlatform(env, platform, platformUserId);
  const plat = platform === 'twitch' ? 'Twitch' : 'Kick';
  if (user) {
    await credit(env, user.id, pack.fichas, `Canje de puntos (${plat})`, ref);
  } else {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO pending_credits (ref, platform, platform_user_id, platform_name, fichas, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(ref, platform, String(platformUserId), displayName || login, pack.fichas, now()).run();
  }
  const name = user?.name || displayName || login || 'Alguien';
  await addFeed(env, 'carga', `${name} cargó ${pack.fichas} ${pack.fichas === 1 ? 'ficha' : 'fichas'} con puntos de ${plat}`, name, pack.fichas);
  if (complete) {
    const job = completeRedemption(env, platform, redemptionId, rewardId, true);
    if (ctx?.waitUntil) ctx.waitUntil(job);
    else await job;
  }
  return { ok: true, credited: !!user, fichas: pack.fichas };
}

export async function twitchWebhook(req, env, ctx) {
  const body = await req.text();
  const id = req.headers.get('Twitch-Eventsub-Message-Id') || '';
  const ts = req.headers.get('Twitch-Eventsub-Message-Timestamp') || '';
  const sig = req.headers.get('Twitch-Eventsub-Message-Signature') || '';
  if (!env.TWITCH_EVENTSUB_SECRET) return new Response('not configured', { status: 503 });
  const expected = 'sha256=' + (await hmacHex(env.TWITCH_EVENTSUB_SECRET, id + ts + body));
  if (!safeEqual(expected, sig)) return new Response('bad signature', { status: 403 });
  if (Math.abs(now() - Date.parse(ts)) > 10 * 60_000) return new Response('stale', { status: 403 });

  const type = req.headers.get('Twitch-Eventsub-Message-Type');
  const data = JSON.parse(body);
  if (type === 'webhook_callback_verification') {
    return new Response(data.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (type === 'revocation') {
    await setSetting(env, 'twitch_eventsub_revoked', { at: now(), reason: data.subscription?.status });
    return new Response(null, { status: 204 });
  }
  if (type !== 'notification' || (await alreadySeen(env, `tw:${id}`))) return new Response(null, { status: 204 });

  if (data.subscription?.type === 'channel.channel_points_custom_reward_redemption.add') {
    const ev = data.event;
    await handleRedemption(env, ctx, {
      platform: 'twitch', redemptionId: ev.id, rewardId: ev.reward.id,
      platformUserId: ev.user_id, login: ev.user_login, displayName: ev.user_name,
    });
  }
  return new Response(null, { status: 204 });
}

// ---------- Kick: firma RSA (clave pública oficial, se descarga y se cachea) ----------
let kickKeyCache = null;

async function kickPublicKey(env) {
  if (kickKeyCache && kickKeyCache.exp > now()) return kickKeyCache.key;
  let pem = env.KICK_PUBLIC_KEY;
  if (!pem) {
    const res = await fetch('https://api.kick.com/public/v1/public-key');
    const j = await res.json();
    pem = j.data?.public_key || j.public_key;
  }
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  kickKeyCache = { key, exp: now() + 3600_000 };
  return key;
}

export async function kickWebhook(req, env, ctx) {
  const body = await req.text();
  const id = req.headers.get('Kick-Event-Message-Id') || '';
  const ts = req.headers.get('Kick-Event-Message-Timestamp') || '';
  const sig = req.headers.get('Kick-Event-Signature') || '';
  const type = req.headers.get('Kick-Event-Type') || '';
  let valid = false;
  try {
    const key = await kickPublicKey(env);
    const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, new TextEncoder().encode(`${id}.${ts}.${body}`));
  } catch {
    valid = false;
  }
  if (!valid) return new Response('bad signature', { status: 403 });
  if (await alreadySeen(env, `kick:${id}`)) return new Response(null, { status: 200 });

  if (type === 'channel.reward.redemption.updated') {
    const ev = JSON.parse(body);
    // Se acredita la primera vez que vemos el canje (pendiente o aceptado). Si el streamer lo rechazó, no.
    if (ev.status !== 'rejected' && !(await alreadySeen(env, `kickred:${ev.id}`))) {
      await handleRedemption(env, ctx, {
        platform: 'kick', redemptionId: ev.id, rewardId: ev.reward?.id,
        platformUserId: ev.redeemer?.user_id, login: ev.redeemer?.channel_slug, displayName: ev.redeemer?.username,
        complete: ev.status === 'pending',
      });
    }
  }
  return new Response(null, { status: 200 });
}
