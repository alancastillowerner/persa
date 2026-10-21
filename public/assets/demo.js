/* Modo demostración: simula el servidor para ver la web sin backend (abrir con ?demo). */
(() => {
  'use strict';
  const nombres = ['lucho_mid', 'sofi.gg', 'nachoAD', 'kami_supp', 'tomi_jg', 'vale.top', 'elbrujo', 'meli_adc', 'fran99', 'gonza_lol', 'pau.rift', 'santi_tf'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const now = () => Date.now();
  const rid = () => Math.random().toString(16).slice(2, 10);
  const campeones = [['Ahri', 'Ahri'], ['Sylas', 'Sylas'], ['Yasuo', 'Yasuo'], ['Akali', 'Akali'], ['LeBlanc', 'Leblanc'], ['Viktor', 'Viktor']];

  const profile = {
    name: 'El Persa', site: 'La Grieta del Persa', tagline: 'Pronosticá sus partidas, juntá fichas y canjealas por premios',
    avatar: 'https://files.kick.com/images/user/2825079/profile_image/conversion/e69025b8-33c0-4a72-a8fd-54523245e44e-fullsize.webp',
    kick: 'el_persa', twitch: '', twitter: 'ei_persa', main_platform: 'kick',
  };
  const economy = {
    points_per_ficha: 100, packs: [1, 10, 50], welcome_bonus: 50, comodines: { x2: 25, escudo: 15 },
    platforms: { twitch: { login: true, points: true }, kick: { login: true, points: true } },
  };
  const rewards = [
    { id: 'saludo', name: 'Saludo en vivo', description: 'El Persa te saluda en el stream con tu nombre.', cost: 300, stock: null, icon: 'mic', needs_note: 0, note_hint: '' },
    { id: 'overlay', name: 'Tu nombre en pantalla', description: 'Aparecés en el overlay durante todo un stream.', cost: 150, stock: null, icon: 'star', needs_note: 0, note_hint: '' },
    { id: 'campeon', name: 'Elegís el campeón', description: 'Decidís con qué campeón juega la próxima partida.', cost: 800, stock: null, icon: 'crown', needs_note: 1, note_hint: '¿Qué campeón?' },
    { id: 'build', name: 'Elegís la build', description: 'Armás la build o las runas de una partida.', cost: 500, stock: null, icon: 'sword', needs_note: 1, note_hint: 'Contanos la build o las runas' },
    { id: 'vip', name: 'Rol VIP en Discord', description: 'Rol especial en el Discord de la comunidad por un mes.', cost: 600, stock: 20, icon: 'gem', needs_note: 1, note_hint: 'Tu usuario de Discord' },
    { id: 'review', name: 'Revisión de tu partida', description: 'El Persa mira una partida tuya en vivo y te da consejos.', cost: 1500, stock: 3, icon: 'eye', needs_note: 1, note_hint: 'Tu Riot ID (nombre#tag)' },
    { id: 'duo', name: 'Partida con El Persa', description: 'Jugás una partida normal o ARAM con él.', cost: 3000, stock: 1, icon: 'shield', needs_note: 1, note_hint: 'Tu Riot ID (nombre#tag)' },
  ];

  let game = null;
  let markets = [];
  let feed = [];
  let lastGames = [
    { champion: 'Sylas', champion_key: 'Sylas', result: 'win', kills: 9, deaths: 4, assists: 7 },
    { champion: 'Ahri', champion_key: 'Ahri', result: 'loss', kills: 3, deaths: 6, assists: 8 },
    { champion: 'Viktor', champion_key: 'Viktor', result: 'win', kills: 11, deaths: 2, assists: 6 },
    { champion: 'Akali', champion_key: 'Akali', result: 'win', kills: 7, deaths: 5, assists: 4 },
    { champion: 'Ahri', champion_key: 'Ahri', result: 'loss', kills: 2, deaths: 7, assists: 10 },
  ];
  let feedId = 1;
  let user = null;
  let ledger = [];
  let picks = [];
  let orders = [];
  let inventory = { x2: 1, escudo: 1 };
  let nextEventAt = now() + 6000;
  let endAt = 0;
  let restartAt = 0;
  const leaderboard = nombres.slice(0, 10).map((n, i) => ({ name: n, avatar: null, won: Math.round(4200 / (i + 1.4)), picks_won: 30 - i * 2, picks_total: 48 - i })).sort((a, b) => b.won - a.won);

  function addFeed(kind, text, ago = 0, amount = null) {
    feed.unshift({ id: feedId++, kind, text, amount, created_at: now() - ago });
    feed = feed.slice(0, 30);
  }

  function odds(counts, total, k) {
    const out = {};
    for (const key of Object.keys(counts)) out[key] = Math.round(Math.max(1.1, Math.min(6, (0.9 * (total + 2 * k)) / (counts[key] + 2))) * 100) / 100;
    return out;
  }

  function mk(kind, grp, question, options, closeSec, extra = {}) {
    return {
      id: rid(), kind, grp, question, base: 10, status: 'open', closes_at: game.start_epoch + closeSec * 1000, outcome: null,
      opts: options.map(([key, label]) => ({ key, label })), counts: Object.fromEntries(options.map(([k]) => [k, 4 + Math.floor(Math.random() * 30)])), ...extra,
    };
  }

  function nuevaPartida(gameTimeSec) {
    const [champion, key] = pick(campeones);
    game = { id: rid(), status: 'live', source: 'app', champion, champion_key: key, team: Math.random() < 0.5 ? 'ORDER' : 'CHAOS', mode: 'CLASSIC', start_epoch: now() - gameTimeSec * 1000, kills: 0, deaths: 0, assists: 0, cs: Math.round(gameTimeSec / 9) };
    const especial = markets.find((m) => m.kind === 'custom' && m.status === 'open');
    markets = [
      mk('win', 'partida', '¿El Persa gana la partida?', [['si', 'Gana'], ['no', 'Pierde']], 240),
      mk('kills', 'partida', 'Kills de El Persa', [['mas', 'Más de 5.5'], ['menos', 'Menos de 5.5']], 240),
      mk('deaths', 'partida', 'Muertes de El Persa', [['mas', 'Más de 4.5'], ['menos', 'Menos de 4.5']], 240),
      mk('duration', 'partida', '¿La partida dura más de 30:00?', [['si', 'Sí'], ['no', 'No']], 240),
      mk('firstblood', 'primeros', '¿Su equipo hace la primera sangre?', [['si', 'Sí'], ['no', 'No']], 60),
      mk('death10', 'primeros', '¿El Persa muere antes del minuto 10?', [['si', 'Sí'], ['no', 'No']], 180),
      mk('firstdragon', 'primeros', '¿Su equipo mata el primer dragón?', [['si', 'Sí'], ['no', 'No']], 300),
    ];
    const fb = markets.find((m) => m.kind === 'firstblood');
    if (gameTimeSec > 70) { fb.status = 'resolved'; fb.outcome = 'si'; fb.resolved_at = now() - 20000; }
    markets.push(especial || { ...mk('custom', 'especial', '¿Hace un pentakill en el stream de hoy?', [['o1', 'Sí'], ['o2', 'No']], 0), closes_at: now() + 45 * 60_000 });
    endAt = now() + 4.5 * 60_000;
    addFeed('partida', `El Persa empezó una partida con ${champion}. ¡Pronósticos abiertos!`);
  }

  function resolver(m, outcome) {
    if (m.status !== 'open') return;
    m.status = outcome === 'void' ? 'void' : 'resolved';
    m.outcome = outcome === 'void' ? null : outcome;
    m.resolved_at = now();
    const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
    for (const p of picks.filter((x) => x.market_id === m.id && x.status === 'pending')) {
      if (outcome === 'void') { p.status = 'void'; if (p.boost) inventory[p.boost]++; continue; }
      if (p.option === outcome) { p.status = 'won'; mover(p.payout, 'Pronóstico acertado'); }
      else { p.status = 'lost'; if (p.boost === 'escudo') mover(Math.floor(p.payout / 2), 'Escudo (pronóstico fallado)'); }
      if (user) { user.picks_total++; if (p.status === 'won') { user.picks_won++; user.total_won += p.payout; } }
    }
    if (outcome !== 'void') {
      const pct = Math.round((m.counts[outcome] * 100) / total);
      addFeed('resultado', `${m.question} → ${m.opts.find((o) => o.key === outcome).label}. Acertó el ${pct}%`);
    }
  }

  function mover(delta, reason) {
    if (!user) return;
    user.balance += delta;
    ledger.unshift({ delta, reason, created_at: now() });
  }

  function simular() {
    const t = now();
    if (!game && restartAt && t > restartAt) { restartAt = 0; nuevaPartida(25); }
    if (game) {
      const gt = (t - game.start_epoch) / 1000;
      game.cs = Math.round(gt / 8.5);
      for (const m of markets) if (m.status === 'open' && m.closes_at > t && Math.random() < 0.55) {
        const k = pick(Object.keys(m.counts));
        m.counts[k] += 1 + Math.floor(Math.random() * 2);
      }
      const d10 = markets.find((m) => m.kind === 'death10');
      if (d10 && d10.status === 'open' && gt > 330) { game.deaths++; resolver(d10, 'si'); }
      const dr = markets.find((m) => m.kind === 'firstdragon');
      if (dr && dr.status === 'open' && gt > 380) resolver(dr, 'si');
      const fb = markets.find((m) => m.kind === 'firstblood');
      if (fb && fb.status === 'open' && gt > 95) { game.kills++; resolver(fb, 'si'); }
      if (Math.random() < 0.03) game.kills++;
      if (Math.random() < 0.015) game.assists++;
      if (t > endAt) {
        const win = Math.random() < 0.6;
        const k = Math.max(game.kills, 3 + Math.floor(Math.random() * 6));
        const d = game.deaths + Math.floor(Math.random() * 4);
        for (const m of markets.filter((x) => x.game !== false && x.kind !== 'custom')) {
          const out = { win: win ? 'si' : 'no', kills: k > 5.5 ? 'mas' : 'menos', deaths: d > 4.5 ? 'mas' : 'menos', duration: Math.random() < 0.5 ? 'si' : 'no', death10: 'no', firstdragon: 'void', firstblood: 'void' }[m.kind];
          resolver(m, out);
        }
        lastGames.unshift({ champion: game.champion, champion_key: game.champion_key, result: win ? 'win' : 'loss', kills: k, deaths: d, assists: game.assists });
        lastGames = lastGames.slice(0, 6);
        addFeed('partida', win ? `¡Victoria de El Persa con ${game.champion} (${k}/${d}/${game.assists})!` : `Derrota de El Persa con ${game.champion} (${k}/${d}/${game.assists}).`);
        game = null;
        restartAt = t + 25_000;
      }
    }
    if (t > nextEventAt) {
      nextEventAt = t + 5000 + Math.random() * 9000;
      const n = pick(nombres);
      const r = Math.random();
      const f = pick([1, 10, 10, 50]);
      if (r < 0.55) addFeed('carga', `${n} cargó ${f} ${f === 1 ? 'ficha' : 'fichas'} con puntos de ${pick(['Kick', 'Kick', 'Twitch'])}`, 0, f);
      else if (r < 0.8) { const rw = pick(rewards); addFeed('premio', `${n} canjeó "${rw.name}"`, 0, rw.cost); }
      else addFeed('registro', `${n} se sumó a la Grieta`);
    }
  }

  function decorate(m) {
    const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
    const o = odds(m.counts, total, m.opts.length);
    const status = m.status === 'open' && now() >= m.closes_at ? 'closed' : m.status;
    return {
      id: m.id, kind: m.kind, grp: m.grp, question: m.question, base: m.base, status, closes_at: m.closes_at, outcome: m.outcome, resolved_at: m.resolved_at || null, total,
      options: m.opts.map((x) => ({ key: x.key, label: x.label, count: m.counts[x.key], pct: total ? Math.round((m.counts[x.key] * 100) / total) : 0, odds: o[x.key] })),
    };
  }

  function state() {
    simular();
    return {
      ok: true, server_time: now(), profile, economy, ddragon: '14.24.1', app_online: true,
      game: game && { ...game, game_time: (now() - game.start_epoch) / 1000, updated_at: now() },
      markets: markets.filter((m) => m.status === 'open' || now() - (m.resolved_at || 0) < 600_000).map(decorate),
      feed: feed.slice(0, 25), last_games: lastGames, leaderboard: user && user.total_won ? [...leaderboard, { name: user.name, avatar: null, won: user.total_won, picks_won: user.picks_won, picks_total: user.picks_total }].sort((a, b) => b.won - a.won).slice(0, 10) : leaderboard,
      rewards,
    };
  }

  function me() {
    if (!user) return { ok: true, user: null };
    return {
      ok: true, user: { ...user }, inventory: { ...inventory }, pending_credits: 0, orders: orders.slice(), ledger: ledger.slice(0, 30),
      picks: picks.map((p) => {
        const m = markets.find((x) => x.id === p.market_id);
        return { ...p, question: m?.question || p.question, option_label: m?.opts.find((o) => o.key === p.option)?.label || p.option, outcome_label: m?.outcome ? m.opts.find((o) => o.key === m.outcome)?.label : null };
      }),
    };
  }

  async function handle(method, path, body = {}) {
    await new Promise((r) => setTimeout(r, 120));
    const p = path.split('?')[0];
    if (p === '/api/state') return state();
    if (p === '/api/me') return me();
    if (p === '/api/leaderboard') return { ok: true, rows: state().leaderboard };
    if (p === '/api/dev-login') {
      user = { id: 'demo', name: 'Invitado', avatar: null, balance: 0, kick: body.platform === 'kick' ? 'vos_en_kick' : null, twitch: body.platform === 'twitch' ? 'vos_en_twitch' : null, picks_won: 4, picks_total: 7, total_won: 180 };
      ledger = [];
      mover(50, 'Bono de bienvenida');
      mover(10, 'Canje de puntos (Kick)');
      mover(420, 'Pronóstico acertado');
      addFeed('registro', 'Invitado se sumó a la Grieta');
      return { ok: true };
    }
    if (p === '/api/logout') { user = null; picks = []; return { ok: true }; }
    if (!user) return { ok: false, error: 'Tenés que iniciar sesión.' };
    if (p === '/api/dev-redeem') { mover(10, 'Canje de puntos (Kick)'); addFeed('carga', 'Invitado cargó 10 fichas con puntos de Kick'); return { ok: true }; }
    if (p === '/api/picks') {
      const results = (body.picks || [body]).map((x) => {
        const m = markets.find((y) => y.id === x.market_id);
        if (!m || m.status !== 'open' || m.closes_at <= now()) return { ok: false, error: 'Ese pronóstico ya cerró.' };
        if (picks.some((y) => y.market_id === m.id)) return { ok: false, error: 'Ya hiciste ese pronóstico.' };
        if (x.boost && inventory[x.boost] <= 0) return { ok: false, error: 'No tenés ese comodín.' };
        if (x.boost) inventory[x.boost]--;
        const d = decorate(m);
        const odd = d.options.find((o) => o.key === x.option).odds;
        m.counts[x.option]++;
        const pk = { market_id: m.id, question: m.question, option: x.option, odds: odd, boost: x.boost || null, payout: Math.round(m.base * odd) * (x.boost === 'x2' ? 2 : 1), status: 'pending', created_at: now() };
        picks.unshift(pk);
        return { ok: true, ...pk };
      });
      return { ok: results.some((r) => r.ok), results };
    }
    if (p === '/api/buy') {
      const price = economy.comodines[body.item];
      if (user.balance < price) return { ok: false, error: 'No te alcanzan las fichas.' };
      mover(-price, `Comodín ${body.item === 'x2' ? 'Doble premio' : 'Escudo'} x1`);
      inventory[body.item]++;
      return { ok: true };
    }
    if (p === '/api/redeem') {
      const r = rewards.find((x) => x.id === body.reward_id);
      if (!r) return { ok: false, error: 'Ese premio no existe.' };
      if (r.needs_note && !String(body.note || '').trim()) return { ok: false, error: r.note_hint };
      if (user.balance < r.cost) return { ok: false, error: 'No te alcanzan las fichas.' };
      mover(-r.cost, `Premio: ${r.name}`);
      if (r.stock !== null) r.stock--;
      orders.unshift({ id: rid(), reward_name: r.name, cost: r.cost, note: body.note || null, status: 'pendiente', created_at: now() });
      addFeed('premio', `Invitado canjeó "${r.name}"`);
      return { ok: true };
    }
    return { ok: false, error: 'No disponible en la demo' };
  }

  // Arranque: partida en curso en el minuto 2:30 y algo de actividad previa
  addFeed('registro', 'kami_supp se sumó a la Grieta', 900_000);
  addFeed('premio', 'nachoAD canjeó "Saludo en vivo"', 640_000);
  addFeed('carga', 'sofi.gg cargó 50 fichas con puntos de Kick', 400_000);
  addFeed('resultado', '¿El Persa gana la partida? → Gana. Acertó el 64%', 300_000);
  addFeed('carga', 'tomi_jg cargó 10 fichas con puntos de Twitch', 160_000);
  nuevaPartida(150);
  addFeed('carga', 'lucho_mid cargó 10 fichas con puntos de Kick', 20_000);

  window.GrietaDemo = { handle };
})();
