/* La Grieta del Persa — web de pronósticos */
(() => {
  'use strict';

  // ---------- utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('es-AR');
  const icon = (id, cls = 'i', style = '') => `<svg class="${cls}" aria-hidden="true"${style ? ` style="${style}"` : ''}><use href="#${id}"/></svg>`;
  const ficha = (n, cls = '') => `<span class="ficha ${cls}"><svg aria-hidden="true"><use href="#i-ficha"/></svg><span class="num">${fmt(n)}</span></span>`;
  const fichaIco = '<svg width="18" height="18" aria-hidden="true" style="flex:none"><use href="#i-ficha"/></svg>';
  const plural = (n, uno, varios) => `${fmt(n)} ${n === 1 ? uno : varios}`;
  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const hace = (t) => {
    const d = Math.max(0, (serverNow() - t) / 1000);
    if (d < 45) return 'recién';
    if (d < 3600) return `hace ${Math.round(d / 60)} min`;
    if (d < 86400) return `hace ${Math.round(d / 3600)} h`;
    return new Date(t).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  };
  const ICONOS_PREMIO = { mic: 'i-mic', star: 'i-star', crown: 'i-crown', sword: 'i-sword', gem: 'i-gem', eye: 'i-eye', shield: 'i-shield', gift: 'i-regalo' };
  const GRUPOS = [
    ['partida', 'Resultado de la partida', 'Cierran al minuto 4'],
    ['primeros', 'Primeros minutos', 'Se resuelven en vivo'],
    ['especial', 'Especiales', 'Los abre El Persa durante el stream'],
  ];

  // Si una imagen externa no carga (avatar, campeón), se reemplaza por la inicial o se oculta
  const caidas = new Set();
  const avatarHtml = (src, nombre, cls = 'avatar', tipo = 'avatar') => {
    const ini = esc((nombre || '?').slice(0, 1).toUpperCase());
    return src && !caidas.has(src) ? `<img class="${cls}" src="${esc(src)}" alt="" data-ini="${ini}" data-tipo="${tipo}">` : `<span class="${tipo}">${ini}</span>`;
  };
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || img.dataset.caida) return;
    img.dataset.caida = '1';
    caidas.add(img.getAttribute('src'));
    if (!img.dataset.ini) { img.style.display = 'none'; return; }
    const span = document.createElement('span');
    span.className = img.dataset.tipo || 'avatar';
    span.textContent = img.dataset.ini;
    img.replaceWith(span);
  }, true);

  // ---------- estado ----------
  let demo = false;
  const S = {
    state: null, me: null, route: 'vivo', skew: 0,
    slip: new Map(),            // market_id -> { option, boost }
    cuponTab: 'cupon', rankingPeriod: 'month', rankingRows: null,
    menuOpen: false, enviando: false,
  };
  const serverNow = () => Date.now() + S.skew;
  const user = () => S.me?.user || null;
  const perfil = () => S.state?.profile || {};

  async function api(method, path, body) {
    if (demo) return window.GrietaDemo.handle(method, path, body);
    const res = await fetch(path, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json', 'x-grieta': '1' } : {},
      body: body ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
      credentials: 'same-origin',
    });
    if (!(res.headers.get('content-type') || '').includes('json')) throw new Error('sin-api');
    const data = await res.json();
    if (!res.ok && !data.error) data.error = `Error ${res.status}`;
    return data;
  }

  // ---------- avisos ----------
  function aviso(texto, tipo = '') {
    const el = document.createElement('div');
    el.className = `aviso ${tipo}`;
    el.textContent = texto;
    $('#avisos').appendChild(el);
    setTimeout(() => el.remove(), tipo === 'error' ? 6000 : 4200);
  }

  // ---------- modales ----------
  let modalPrevFocus = null;
  function abrirModal(titulo, html, onMount) {
    modalPrevFocus = document.activeElement;
    $('#modal-raiz').innerHTML = `
      <div class="capa" data-cerrar>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-t">
          <header><h2 id="modal-t">${esc(titulo)}</h2><button class="btn fantasma chico" data-cerrar aria-label="Cerrar">${icon('i-x')}</button></header>
          <div class="cuerpo">${html}</div>
        </div>
      </div>`;
    const capa = $('#modal-raiz .capa');
    capa.addEventListener('click', (e) => { if (e.target === capa || e.target.closest('button[data-cerrar]')) cerrarModal(); });
    onMount?.($('#modal-raiz .modal'));
    ($('#modal-raiz [autofocus]') || $('#modal-raiz .modal button'))?.focus();
  }
  function cerrarModal() {
    $('#modal-raiz').innerHTML = '';
    modalPrevFocus?.focus?.();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#modal-raiz').innerHTML) cerrarModal();
      else if (S.menuOpen) { S.menuOpen = false; renderUsuario(); }
      else if ($('#cupon').classList.contains('abierto')) $('#cupon').classList.remove('abierto');
    }
  });

  function modalLogin(motivo) {
    const pl = S.state?.economy?.platforms || {};
    const kick = demo || pl.kick?.login;
    const twitch = demo || pl.twitch?.login;
    const bono = S.state?.economy?.welcome_bonus || 0;
    const back = encodeURIComponent(location.hash ? `/${location.hash}` : '/');
    abrirModal('Entrá a la Grieta', `
      <p>${esc(motivo || 'Entrá con la cuenta con la que mirás el stream.')} ${bono ? `Te regalamos ${plural(bono, 'ficha', 'fichas')} para empezar.` : ''}</p>
      ${kick ? `<a class="btn kick ancho" href="/auth/kick?back=${back}" data-login="kick">Entrar con Kick</a>` : ''}
      ${twitch ? `<a class="btn twitch ancho" href="/auth/twitch?back=${back}" data-login="twitch">Entrar con Twitch</a>` : ''}
      ${!kick && !twitch ? '<p>El inicio de sesión todavía no está configurado.</p>' : ''}
      <p style="font-size:13px">Usamos tu cuenta solo para saber quién sos y acreditarte los puntos de canal que canjees. No publicamos nada en tu nombre.</p>`,
    (m) => {
      if (demo) $$('[data-login]', m).forEach((a) => a.addEventListener('click', async (e) => {
        e.preventDefault();
        await api('POST', '/api/dev-login', { platform: a.dataset.login });
        cerrarModal();
        await cargarMe();
        aviso('¡Listo! Ya estás adentro.', 'oro');
        renderTodo();
      }));
    });
  }

  function modalCargar() {
    const ec = S.state.economy;
    const p = perfil();
    const pl = ec.platforms;
    const plats = [pl.kick?.points || demo ? 'Kick' : null, pl.twitch?.points || demo ? 'Twitch' : null].filter(Boolean);
    const u = user();
    const canal = p.main_platform === 'twitch' && p.twitch ? `https://twitch.tv/${p.twitch}` : p.kick ? `https://kick.com/${p.kick}` : null;
    abrirModal('Cargar fichas con puntos de canal', `
      <p>Cada <b class="num" style="color:var(--pergamino)">${fmt(ec.points_per_ficha)}</b> puntos de canal valen 1 ficha. Los puntos los juntás mirando el stream.</p>
      <div class="packs">${ec.packs.map((n) => `<div class="pack">${fichaIco}<b>${plural(n, 'ficha', 'fichas')}</b><span class="num">${fmt(n * ec.points_per_ficha)} puntos</span></div>`).join('')}</div>
      <ol class="instr">
        <li>Abrí el chat de ${esc(p.name)} en ${plats.length ? plats.join(' o ') : 'Kick o Twitch'}.</li>
        <li>Tocá los <b>puntos del canal</b> y elegí <b>Cargar ${ec.packs[1] || ec.packs[0]} fichas</b>.</li>
        <li>En unos segundos aparecen acá. ${u ? `Usá la misma cuenta con la que entraste${u.kick ? ` (Kick: ${esc(u.kick)})` : ''}${u.twitch ? ` (Twitch: ${esc(u.twitch)})` : ''}.` : 'Si todavía no entraste, te las guardamos hasta que entres con esa cuenta.'}</li>
      </ol>
      ${!plats.length ? '<p>El streamer todavía no activó las recompensas de puntos de canal.</p>' : ''}
      ${canal ? `<a class="btn oro ancho" href="${esc(canal)}" target="_blank" rel="noopener">${icon('i-play')}Abrir el canal</a>` : ''}
      ${demo ? '<button class="btn ancho" id="demo-cargar">Simular un canje de 1.000 puntos</button>' : ''}`,
    (m) => {
      $('#demo-cargar', m)?.addEventListener('click', async () => {
        await api('POST', '/api/dev-redeem', {});
        cerrarModal();
        await cargarMe();
        renderTodo();
        aviso('Canje recibido: +10 fichas', 'oro');
      });
    });
  }

  function modalCanje(r) {
    const u = user();
    if (!u) return modalLogin('Entrá para canjear premios.');
    const falta = r.cost - u.balance;
    abrirModal(r.name, `
      <p>${esc(r.description)}</p>
      <div class="pack">${fichaIco}<b>Cuesta ${plural(r.cost, 'ficha', 'fichas')}</b><span>Tenés ${fmt(u.balance)}</span></div>
      ${r.needs_note ? `<label>${esc(r.note_hint || 'Dato para el streamer')}<input class="campo" id="nota" maxlength="200" autofocus></label>` : ''}
      ${falta > 0 ? `<p>Te faltan ${plural(falta, 'ficha', 'fichas')}. Acertá pronósticos o cargá fichas con puntos de canal.</p>` : '<p>El Persa ve tu canje en su panel y lo cumple en el stream.</p>'}
      <button class="btn oro ancho" id="confirmar" ${falta > 0 ? 'disabled' : ''}>Canjear premio</button>`,
    (m) => {
      $('#confirmar', m).addEventListener('click', async (e) => {
        e.target.disabled = true;
        const r2 = await api('POST', '/api/redeem', { reward_id: r.id, note: $('#nota', m)?.value || '' });
        if (!r2.ok) { aviso(r2.error, 'error'); e.target.disabled = false; return; }
        cerrarModal();
        aviso(`Canjeaste "${r.name}". El Persa ya lo ve en su panel.`, 'oro');
        await Promise.all([cargarMe(), refrescar()]);
      });
    });
  }

  async function comprarComodin(item) {
    if (!user()) return modalLogin('Entrá para comprar comodines.');
    const r = await api('POST', '/api/buy', { item, qty: 1 });
    if (!r.ok) return aviso(r.error, 'error');
    aviso(item === 'x2' ? 'Compraste un Doble premio.' : 'Compraste un Escudo.', 'oro');
    await cargarMe();
    renderTodo();
  }

  // ---------- carga de datos ----------
  async function refrescar() {
    try {
      const s = await api('GET', '/api/state');
      if (!s.ok) return;
      S.state = s;
      S.skew = s.server_time - Date.now();
      for (const id of S.slip.keys()) {
        const m = s.markets.find((x) => x.id === id);
        if (!m || m.status !== 'open' || m.closes_at <= serverNow()) S.slip.delete(id);
      }
      renderTodo();
    } catch { /* sin conexión: reintenta en el próximo ciclo */ }
  }

  async function cargarMe() {
    try {
      const r = await api('GET', '/api/me');
      S.me = r.ok && r.user ? r : null;
    } catch {
      S.me = null;
    }
  }

  // ---------- render: barra superior y lateral ----------
  function renderUsuario() {
    const u = user();
    const z = $('#zona-usuario');
    if (!u) {
      z.innerHTML = `<button class="btn fantasma" id="btn-cargar-anon">${fichaIco}Cargar fichas</button><button class="btn oro" id="btn-entrar">Entrar</button>`;
      $('#btn-entrar').onclick = () => modalLogin();
      $('#btn-cargar-anon').onclick = modalCargar;
      return;
    }
    const ini = esc((u.name || '?').slice(0, 1).toUpperCase());
    z.innerHTML = `
      <div class="saldo" title="Tus fichas">
        <svg width="18" height="18" aria-hidden="true"><use href="#i-ficha"/></svg>
        <span class="num" id="saldo-num">${fmt(u.balance)}</span>
        <button class="btn oro" id="btn-cargar">${icon('i-mas')}<span>Cargar</span></button>
      </div>
      <div class="menu-user">
        <button id="btn-menu" aria-haspopup="true" aria-expanded="${S.menuOpen}" aria-label="Tu cuenta">
          ${avatarHtml(u.avatar, u.name)}
        </button>
        ${S.menuOpen ? `
        <div class="desplegable" role="menu">
          <div class="quien"><b>${esc(u.name)}</b><span>${[u.kick && `Kick: ${esc(u.kick)}`, u.twitch && `Twitch: ${esc(u.twitch)}`].filter(Boolean).join(' / ')}</span></div>
          <a href="#jugadas" role="menuitem">${icon('i-lista')}Mis pronósticos</a>
          ${!u.kick ? `<a href="/auth/kick?mode=link" role="menuitem" data-vincular="kick">${icon('i-mas')}Vincular cuenta de Kick</a>` : ''}
          ${!u.twitch ? `<a href="/auth/twitch?mode=link" role="menuitem" data-vincular="twitch">${icon('i-mas')}Vincular cuenta de Twitch</a>` : ''}
          <button role="menuitem" id="btn-salir">${icon('i-salir')}Salir</button>
        </div>` : ''}
      </div>`;
    $('#btn-cargar').onclick = modalCargar;
    $('#btn-menu').onclick = (e) => { e.stopPropagation(); S.menuOpen = !S.menuOpen; renderUsuario(); };
    $('#btn-salir')?.addEventListener('click', async () => {
      await api('POST', '/api/logout');
      S.me = null; S.menuOpen = false;
      renderTodo();
    });
    if (demo) $$('[data-vincular]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); aviso('En la versión real esto abre el login de la otra plataforma.'); }));
  }
  document.addEventListener('click', (e) => {
    if (S.menuOpen && !e.target.closest('.menu-user')) { S.menuOpen = false; renderUsuario(); }
  });

  function renderLateral() {
    const u = user();
    const inv = S.me?.inventory || { x2: 0, escudo: 0 };
    $('#bloque-inventario').innerHTML = u ? `
      <h4>Tus comodines</h4>
      <div class="inv">
        <div class="fila">${icon('i-rayo', 'i', 'color:var(--firuze)')}Doble premio<b>${inv.x2}</b></div>
        <div class="fila">${icon('i-escudo', 'i', 'color:var(--firuze)')}Escudo<b>${inv.escudo}</b></div>
      </div>
      <a class="btn chico ancho" href="#tienda" style="margin-top:10px">Comprar comodines</a>`
      : `<h4>Tu cuenta</h4><p class="muted" style="margin:0 0 10px">Entrá para pronosticar y juntar fichas.</p><button class="btn oro chico ancho" id="lat-entrar">Entrar</button>`;
    $('#lat-entrar')?.addEventListener('click', () => modalLogin());
    const p = perfil();
    const g = S.state?.game;
    const canal = p.kick ? { url: `https://kick.com/${p.kick}`, txt: 'Ver en Kick' } : p.twitch ? { url: `https://twitch.tv/${p.twitch}`, txt: 'Ver en Twitch' } : null;
    $('#bloque-stream').innerHTML = `
      <h4>El stream</h4>
      <div style="display:flex;gap:10px;align-items:center">
        ${avatarHtml(p.avatar, p.name)}
        <div><b>${esc(p.name)}</b><div class="muted" style="font-size:12px">${g ? 'En partida ahora' : 'Fuera de partida'}</div></div>
      </div>
      ${canal ? `<a class="btn chico ancho" style="margin-top:10px" href="${esc(canal.url)}" target="_blank" rel="noopener">${icon('i-play')}${canal.txt}</a>` : ''}`;
    const abiertos = (S.state?.markets || []).filter((m) => m.status === 'open' && m.closes_at > serverNow()).length;
    $('#cuenta-abiertos').textContent = abiertos;
    $('#cuenta-abiertos').classList.toggle('hidden', !abiertos);
    $('#punto-lateral').classList.toggle('hidden', !g);
    $('#ico-vivo-lateral').classList.toggle('hidden', !!g);
  }

  // ---------- render: la partida ----------
  function champIcon(key) {
    const v = S.state?.ddragon;
    return key && v ? `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${encodeURIComponent(key)}.png` : null;
  }

  function heroPartida() {
    const p = perfil();
    const g = S.state.game;
    const retrato = `<div class="retrato">${avatarHtml(p.avatar, p.name, '', 'ini')}
      ${g && champIcon(g.champion_key) && !caidas.has(champIcon(g.champion_key)) ? `<img class="campeon" src="${esc(champIcon(g.champion_key))}" alt="${esc(g.champion)}">` : ''}</div>`;
    const ult = S.state.last_games || [];
    const hist = ult.length ? `<div class="historial" aria-label="Últimas partidas">${ult.map((x) => `<span class="r ${x.result}" title="${esc(x.champion || '')} ${x.kills}/${x.deaths}/${x.assists}">${x.result === 'win' ? 'V' : 'D'}</span>`).join('')}</div>` : '';
    if (!g) {
      return `<section class="partida" aria-label="Estado de la partida"><div class="contenido">
        ${retrato}
        <div>
          <h1>Esperando la próxima partida</h1>
          <div class="estado"><span class="chip espera">Fuera de partida</span><span>Cuando ${esc(p.name)} entre a una partida se abren los pronósticos.</span></div>
          ${hist ? `<div style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="muted" style="font-size:13px">Últimas partidas</span>${hist}</div>` : ''}
        </div>
        <div class="reloj"><button class="btn oro" id="hero-cargar">${fichaIco}Cargar fichas</button></div>
      </div></section>`;
    }
    const equipo = g.team === 'ORDER' ? 'Lado azul' : g.team === 'CHAOS' ? 'Lado rojo' : null;
    const fuente = g.source === 'app' ? 'Datos en vivo desde su PC' : 'Datos de la API de Riot';
    return `<section class="partida" aria-label="Partida en vivo"><div class="contenido">
      ${retrato}
      <div>
        <h1>${esc(p.name)}${g.champion ? ` con ${esc(g.champion)}` : ' en partida'}</h1>
        <div class="estado">
          <span class="chip vivo"><span class="punto-vivo"></span>En vivo</span>
          ${equipo ? `<span>${equipo}</span>` : ''}
          <span>${fuente}</span>
        </div>
        ${g.source === 'app' ? `<div class="kda" aria-label="Estadísticas">
          <div><b>${g.kills}</b><span>Kills</span></div><div><b>${g.deaths}</b><span>Muertes</span></div>
          <div><b>${g.assists}</b><span>Asistencias</span></div><div><b>${g.cs}</b><span>Súbditos</span></div></div>` : ''}
      </div>
      <div class="reloj"><span class="num" data-start="${g.start_epoch}">${mmss((serverNow() - g.start_epoch) / 1000)}</span><small>Tiempo de partida</small></div>
    </div></section>`;
  }

  function filaMercado(m) {
    const t = serverNow();
    const abierto = m.status === 'open' && m.closes_at > t;
    const miPick = (S.me?.picks || []).find((p) => p.market_id === m.id);
    const enCupon = S.slip.get(m.id);
    let meta = '';
    if (abierto) {
      const resta = (m.closes_at - t) / 1000;
      meta = `<span class="cierra ${resta < 30 ? 'urgente' : ''}">${icon('i-reloj')}Cierra en <span class="num" data-closes="${m.closes_at}">${mmss(resta)}</span></span>`;
    } else if (m.status === 'open' || m.status === 'closed') meta = '<span>Cerrado, esperando el resultado</span>';
    else if (m.status === 'void') meta = '<span>Anulado: no cuenta para nadie</span>';
    else meta = `<span>Resultado: <b style="color:var(--pergamino)">${esc(m.options.find((o) => o.key === m.outcome)?.label || '')}</b></span>`;
    meta += `<span>${icon('i-gente')} ${plural(m.total, 'jugada', 'jugadas')}</span>`;

    const botones = m.options.map((o) => {
      const sel = enCupon?.option === o.key;
      const cls = [miPick?.option === o.key ? 'elegida' : '', m.status === 'resolved' && m.outcome === o.key ? 'gano' : ''].join(' ');
      return `<button class="cuota ${cls}" data-m="${m.id}" data-o="${o.key}" aria-pressed="${sel}" ${!abierto || miPick ? 'disabled' : ''}
        aria-label="${esc(o.label)}, cuota ${o.odds.toFixed(2)}, ${o.pct}% de la gente">
        <span>${esc(o.label)}</span><b>${o.odds.toFixed(2)}</b><i class="barra" style="width:${o.pct}%"></i></button>`;
    }).join('');

    let tuyo = '';
    if (miPick) {
      const txt = { pending: `Tu pronóstico: ${esc(miPick.option_label)}. Premio si acertás: ${fmt(miPick.payout)} fichas`, won: `Acertaste: +${fmt(miPick.payout)} fichas`, lost: miPick.boost === 'escudo' ? `Fallaste, el escudo te devolvió ${fmt(Math.floor(miPick.payout / 2))} fichas` : 'Fallaste este', void: 'Tu pronóstico se anuló' }[miPick.status];
      tuyo = `<div class="marca-pick ${miPick.status}">${txt}${miPick.boost ? ` (${miPick.boost === 'x2' ? 'Doble premio' : 'Escudo'})` : ''}</div>`;
    }
    return `<div class="mercado"><div><div class="preg">${esc(m.question)}</div><div class="meta">${meta}</div>${tuyo}</div><div class="cuotas">${botones}</div></div>`;
  }

  function vistaVivo() {
    const ms = S.state.markets || [];
    const orden = (a, b) => {
      const ra = a.status === 'open' && a.closes_at > serverNow() ? 0 : a.status === 'open' ? 1 : 2;
      const rb = b.status === 'open' && b.closes_at > serverNow() ? 0 : b.status === 'open' ? 1 : 2;
      return ra - rb;
    };
    let html = heroPartida();
    let hay = false;
    for (const [grp, titulo, sub] of GRUPOS) {
      const lista = ms.filter((m) => m.grp === grp).sort(orden);
      if (!lista.length) continue;
      hay = true;
      html += `<section class="grupo"><h2>${titulo}<small>${sub}</small></h2><div class="mercados">${lista.map(filaMercado).join('')}</div></section>`;
    }
    if (!hay) {
      html += `<div class="panel vacio"><b>No hay pronósticos abiertos</b>Se abren solos cuando empieza una partida. Mientras tanto podés cargar fichas o mirar la tienda.</div>`;
    }
    return html;
  }

  // ---------- render: otras secciones ----------
  function vistaJugadas() {
    const u = user();
    if (!u) return `<div class="panel vacio"><b>Entrá para ver tus pronósticos</b><p>Tus jugadas, tus fichas y tus canjes quedan guardados en tu cuenta.</p><button class="btn oro" data-accion="login">Entrar</button></div>`;
    const me = S.me;
    const acc = u.picks_total ? Math.round((u.picks_won * 100) / u.picks_total) : 0;
    const estado = { pending: 'Pendiente', won: 'Acertado', lost: 'Fallado', void: 'Anulado' };
    const ordenEstado = { pendiente: 'Pendiente', cumplido: 'Cumplido', devuelto: 'Devuelto' };
    return `
      <section class="pasos" aria-label="Resumen">
        <div class="paso"><span class="muted">Saldo</span><h3 class="num" style="font-size:28px;margin-top:4px;color:var(--oro-claro)">${fmt(u.balance)}</h3><p>fichas disponibles</p></div>
        <div class="paso"><span class="muted">Aciertos</span><h3 class="num" style="font-size:28px;margin-top:4px">${acc}%</h3><p>${fmt(u.picks_won)} de ${fmt(u.picks_total)} pronósticos</p></div>
        <div class="paso"><span class="muted">Ganado en pronósticos</span><h3 class="num" style="font-size:28px;margin-top:4px">${fmt(u.total_won)}</h3><p>fichas en total</p></div>
      </section>
      ${me.pending_credits ? `<div class="aviso oro" style="animation:none">Tenés ${me.pending_credits} canje(s) de puntos esperando: se acreditan solos.</div>` : ''}
      <section class="panel"><header><h2>Tus pronósticos</h2></header>
        ${me.picks.length ? `<div style="overflow:auto"><table class="tabla"><thead><tr><th>Pronóstico</th><th>Tu elección</th><th>Cuota</th><th>Premio</th><th>Estado</th></tr></thead><tbody>
        ${me.picks.map((p) => `<tr><td>${esc(p.question)}${p.outcome_label ? `<div class="muted" style="font-size:12px">Salió: ${esc(p.outcome_label)}</div>` : ''}</td>
          <td>${esc(p.option_label)}${p.boost ? `<div class="muted" style="font-size:12px">${p.boost === 'x2' ? 'Doble premio' : 'Escudo'}</div>` : ''}</td>
          <td class="num">${p.odds.toFixed(2)}</td><td class="num">${fmt(p.payout)}</td><td><span class="estado-pick ${p.status}">${estado[p.status]}</span></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="vacio">Todavía no hiciste pronósticos. Tocá una cuota en <a href="#vivo">En vivo</a>.</div>'}
      </section>
      <section class="panel"><header><h2>Movimientos de fichas</h2></header>
        ${me.ledger.length ? `<table class="tabla"><tbody>${me.ledger.map((l) => `<tr><td>${esc(l.reason)}<div class="muted" style="font-size:12px">${hace(l.created_at)}</div></td><td class="num ${l.delta >= 0 ? 'delta-pos' : 'delta-neg'}" style="text-align:right">${l.delta >= 0 ? '+' : ''}${fmt(l.delta)}</td></tr>`).join('')}</tbody></table>` : '<div class="vacio">Sin movimientos todavía.</div>'}
      </section>
      ${me.orders.length ? `<section class="panel"><header><h2>Tus canjes</h2></header><table class="tabla"><tbody>${me.orders.map((o) => `<tr><td>${esc(o.reward_name)}${o.note ? `<div class="muted" style="font-size:12px">${esc(o.note)}</div>` : ''}</td><td class="num">${fmt(o.cost)}</td><td>${ordenEstado[o.status]}</td></tr>`).join('')}</tbody></table></section>` : ''}`;
  }

  function vistaTienda() {
    const ec = S.state.economy;
    const u = user();
    const premios = S.state.rewards || [];
    return `
      <section class="grupo"><h2>Comodines<small>Se usan desde el cupón, uno por pronóstico</small></h2>
        <div class="tienda">
          <div class="premio-card comodin-card"><div class="ico">${icon('i-rayo')}</div><h3>Doble premio</h3><p>Duplica lo que cobrás si acertás ese pronóstico.</p>
            <div class="pie"><span class="precio">${ficha(ec.comodines.x2)}</span><button class="btn chico" data-comprar="x2">Comprar</button></div></div>
          <div class="premio-card comodin-card"><div class="ico">${icon('i-escudo')}</div><h3>Escudo</h3><p>Si fallás ese pronóstico, cobrás igual la mitad del premio.</p>
            <div class="pie"><span class="precio">${ficha(ec.comodines.escudo)}</span><button class="btn chico" data-comprar="escudo">Comprar</button></div></div>
        </div>
      </section>
      <section class="grupo"><h2>Premios<small>El Persa los cumple en el stream</small></h2>
        <div class="tienda">${premios.map((r) => `
          <div class="premio-card"><div class="ico">${icon(ICONOS_PREMIO[r.icon] || 'i-star')}</div>
            <h3>${esc(r.name)}</h3><p>${esc(r.description)}</p>
            <div class="pie"><span><span class="precio">${ficha(r.cost)}</span>${r.stock !== null && r.stock !== undefined ? `<div class="stock">${r.stock > 0 ? `Quedan ${r.stock}` : 'Agotado'}</div>` : ''}</span>
            <button class="btn ${u && u.balance >= r.cost ? 'oro' : ''} chico" data-premio="${esc(r.id)}" ${r.stock === 0 ? 'disabled' : ''}>Canjear</button></div>
          </div>`).join('') || '<div class="vacio">Pronto vas a encontrar premios acá.</div>'}
        </div>
      </section>`;
  }

  function filasRanking(rows) {
    if (!rows || !rows.length) return '<li class="muted" style="display:block">Todavía nadie sumó fichas este mes. ¿Vas a ser el primero?</li>';
    return rows.map((r, i) => `<li><span class="pos">${i + 1}</span>
      ${avatarHtml(r.avatar, r.name)}
      <span class="nom">${esc(r.name)}<small>${r.picks_total ? Math.round((r.picks_won * 100) / r.picks_total) : 0}% de aciertos</small></span>
      <span class="pts">${fmt(r.won)}</span></li>`).join('');
  }

  function vistaRanking() {
    const rows = S.rankingRows || S.state.leaderboard;
    return `<section class="panel"><header><h2>Ranking</h2>
      <div class="extra" role="tablist" style="display:flex;gap:4px">
        <button class="btn chico ${S.rankingPeriod === 'month' ? '' : 'fantasma'}" data-periodo="month" role="tab" aria-selected="${S.rankingPeriod === 'month'}">Este mes</button>
        <button class="btn chico ${S.rankingPeriod === 'all' ? '' : 'fantasma'}" data-periodo="all" role="tab" aria-selected="${S.rankingPeriod === 'all'}">Histórico</button>
      </div></header>
      <p class="muted" style="margin:12px 16px 0;font-size:13px">Fichas ganadas acertando pronósticos. Las cargas con puntos de canal no cuentan.</p>
      <ol class="ranking" style="padding:8px 0 12px">${filasRanking(rows)}</ol></section>`;
  }

  function vistaAyuda() {
    const ec = S.state.economy;
    const p = perfil();
    return `
      <section class="pasos" aria-label="Cómo funciona">
        <div class="paso"><span class="n">1</span><h3>Entrá con Kick o Twitch</h3><p>Con la misma cuenta con la que mirás a ${esc(p.name)}. Te regalamos ${plural(ec.welcome_bonus, 'ficha', 'fichas')} para arrancar.</p></div>
        <div class="paso"><span class="n">2</span><h3>Pronosticá gratis</h3><p>Elegí qué va a pasar en la partida. Pronosticar no cuesta fichas: si acertás, cobrás el premio según la cuota.</p></div>
        <div class="paso"><span class="n">3</span><h3>Canjeá premios</h3><p>Usá tus fichas en la tienda: saludos, elegir campeón, jugar con ${esc(p.name)} y más.</p></div>
      </section>
      <section class="faq">
        <details open><summary>¿Cómo cargo fichas con puntos de canal?</summary><p>Cada ${fmt(ec.points_per_ficha)} puntos de canal valen 1 ficha. En el chat del stream abrí los puntos del canal y elegí una de las recompensas “Cargar fichas”. Se acreditan solas en segundos a la cuenta con la que entraste.</p></details>
        <details><summary>¿Qué es la cuota?</summary><p>Es el multiplicador del premio. Las opciones que elige menos gente pagan más. La cuota queda fija en el momento en que confirmás tu pronóstico.</p></details>
        <details><summary>¿Por qué se anuló mi pronóstico?</summary><p>El stream tiene unos segundos de retraso. Si algo pasa en la partida mientras un pronóstico sigue abierto, se anulan los que se hicieron en los 30 segundos anteriores, para que nadie juegue con ventaja. También se anulan si la partida se cancela (remake). Los comodines usados se devuelven.</p></details>
        <details><summary>¿Las fichas valen plata?</summary><p>No. No se compran con dinero, no se venden y no se cambian por dinero. Solo sirven para los premios de esta comunidad.</p></details>
        <details><summary>Canjeé puntos antes de registrarme, ¿los perdí?</summary><p>No. Te los guardamos y se acreditan apenas entrás con esa misma cuenta de Kick o Twitch.</p></details>
        <details><summary>¿Puedo usar Kick y Twitch en la misma cuenta?</summary><p>Sí. Entrá con una y desde tu menú vinculá la otra. Tus fichas quedan juntas.</p></details>
      </section>`;
  }

  // ---------- render: cupón ----------
  function renderCupon() {
    const el = $('#cupon');
    const u = user();
    const inv = { ...(S.me?.inventory || { x2: 0, escudo: 0 }) };
    const items = [...S.slip.entries()].map(([id, v]) => ({ m: S.state.markets.find((x) => x.id === id), ...v })).filter((x) => x.m);
    for (const it of items) if (it.boost) inv[it.boost]--;
    const abiertos = (S.me?.picks || []).filter((p) => p.status === 'pending');
    const tab = S.cuponTab;
    let html = `<div class="tabs" role="tablist">
      <button role="tab" aria-selected="${tab === 'cupon'}" data-tab="cupon">Cupón${items.length ? ` (${items.length})` : ''}</button>
      <button role="tab" aria-selected="${tab === 'abiertos'}" data-tab="abiertos">En juego${abiertos.length ? ` (${abiertos.length})` : ''}</button>
      <button class="cerrar-hoja" data-cerrar-cupon aria-label="Cerrar cupón">${icon('i-x')}</button></div>`;
    if (tab === 'cupon') {
      if (!items.length) {
        html += `<div class="vacio" style="padding:22px 16px">${icon('i-ticket', 'i', 'width:28px;height:28px;color:var(--niebla-2);margin:0 auto 8px;display:block')}Tocá una cuota para sumarla al cupón. Pronosticar es gratis.</div>`;
      } else {
        let total = 0;
        html += items.map(({ m, option, boost }) => {
          const o = m.options.find((x) => x.key === option);
          const premio = Math.round(m.base * o.odds) * (boost === 'x2' ? 2 : 1);
          total += premio;
          return `<div class="pick">
            <div><div class="q">${esc(m.question)}</div><div class="o">${esc(o.label)}</div></div>
            <div class="c num">${o.odds.toFixed(2)}</div>
            <div class="muted" style="font-size:12px">Premio: <b class="num" style="color:var(--oro-claro)">${fmt(premio)}</b></div>
            <button class="quitar" data-quitar="${m.id}">Quitar</button>
            ${u ? `<div class="comodines">
              <button class="toggle" data-boost="x2" data-mid="${m.id}" aria-pressed="${boost === 'x2'}" ${boost !== 'x2' && inv.x2 <= 0 ? 'disabled' : ''}>${icon('i-rayo', 'i', 'width:14px;height:14px')}Doble premio</button>
              <button class="toggle" data-boost="escudo" data-mid="${m.id}" aria-pressed="${boost === 'escudo'}" ${boost !== 'escudo' && inv.escudo <= 0 ? 'disabled' : ''}>${icon('i-escudo', 'i', 'width:14px;height:14px')}Escudo</button>
            </div>` : ''}
          </div>`;
        }).join('');
        html += `<div class="total">
          <div class="fila"><span>Pronósticos</span><b>${items.length}</b></div>
          <div class="fila premio"><span>Ganás si acertás todos</span><b class="num">${fmt(total)}</b></div>
          <p class="nota">Cada pronóstico se cobra por separado. La cuota puede moverse hasta que confirmes.</p>
          ${u ? `<button class="btn oro ancho" id="confirmar-cupon" ${S.enviando ? 'disabled' : ''}>Confirmar ${items.length === 1 ? 'pronóstico' : 'pronósticos'}</button>`
              : `<button class="btn oro ancho" data-accion="login">Entrar para confirmar</button>`}
          <button class="btn fantasma chico" id="vaciar-cupon">Vaciar cupón</button>
        </div>`;
      }
    } else {
      html += abiertos.length ? abiertos.map((p) => `<div class="pick"><div><div class="q">${esc(p.question)}</div><div class="o">${esc(p.option_label)}</div></div>
          <div class="c num">${p.odds.toFixed(2)}</div><div class="muted" style="font-size:12px;grid-column:1/-1">Cobrás ${fmt(p.payout)} fichas si acertás${p.boost ? ` (${p.boost === 'x2' ? 'Doble premio' : 'Escudo'})` : ''}</div></div>`).join('')
        : `<div class="vacio" style="padding:22px 16px">No tenés pronósticos esperando resultado.</div>`;
    }
    el.innerHTML = html;
    const n = items.length;
    $('#boton-cupon').classList.toggle('hidden', !n);
    $('#boton-cupon-n').textContent = n;
  }

  async function confirmarCupon() {
    const picks = [...S.slip.entries()].map(([market_id, v]) => ({ market_id, option: v.option, boost: v.boost || null }));
    if (!picks.length) return;
    S.enviando = true;
    renderCupon();
    const r = await api('POST', '/api/picks', { picks });
    S.enviando = false;
    if (!r.results) { aviso(r.error || 'No se pudo enviar el cupón.', 'error'); renderCupon(); return; }
    let ok = 0;
    r.results.forEach((res, i) => {
      if (res.ok) { ok++; S.slip.delete(picks[i].market_id); } else aviso(res.error, 'error');
    });
    if (ok) aviso(ok === 1 ? 'Pronóstico confirmado. ¡Suerte!' : `${ok} pronósticos confirmados. ¡Suerte!`, 'oro');
    $('#cupon').classList.remove('abierto');
    await Promise.all([cargarMe(), refrescar()]);
    renderTodo();
  }

  // ---------- render: lado derecho ----------
  function renderLado() {
    $('#ranking-lado').innerHTML = filasRanking((S.state.leaderboard || []).slice(0, 5));
    const ico = { carga: 'i-rayo', premio: 'i-regalo', resultado: 'i-check', partida: 'i-espada2', registro: 'i-registro', regalo: 'i-regalo' };
    $('#actividad').innerHTML = (S.state.feed || []).slice(0, 15).map((f) => `<li class="f-${esc(f.kind)}">${icon(ico[f.kind] || 'i-star')}<span class="t">${esc(f.text)}</span><time>${hace(f.created_at)}</time></li>`).join('')
      || '<li>Acá vas a ver lo que pasa en la comunidad.</li>';
  }

  // ---------- render general ----------
  function renderMain() {
    const vistas = { vivo: vistaVivo, jugadas: vistaJugadas, tienda: vistaTienda, ranking: vistaRanking, ayuda: vistaAyuda };
    $('#principal').innerHTML = (vistas[S.route] || vistaVivo)();
    $('#hero-cargar')?.addEventListener('click', modalCargar);
  }

  function renderTodo() {
    if (!S.state) return;
    $('#nombre-sitio').textContent = perfil().site || 'La Grieta del Persa';
    document.title = S.state.game ? `En vivo: ${perfil().name} | ${perfil().site}` : perfil().site || document.title;
    renderUsuario();
    renderLateral();
    renderMain();
    renderCupon();
    renderLado();
  }

  function route() {
    const r = (location.hash || '#vivo').slice(1);
    S.route = ['vivo', 'jugadas', 'tienda', 'ranking', 'ayuda'].includes(r) ? r : 'vivo';
    $$('[data-ruta]').forEach((a) => a.toggleAttribute('aria-current', false));
    $$(`[data-ruta="${S.route}"]`).forEach((a) => a.setAttribute('aria-current', 'page'));
    if (S.route === 'ranking') cargarRanking();
    renderTodo();
    window.scrollTo({ top: 0 });
  }

  async function cargarRanking() {
    const r = await api('GET', `/api/leaderboard?period=${S.rankingPeriod}`).catch(() => null);
    if (r?.ok) { S.rankingRows = r.rows; if (S.route === 'ranking') renderMain(); }
  }

  // ---------- eventos (delegados) ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.matches('.cuota[data-m]')) {
      const id = t.dataset.m;
      const cur = S.slip.get(id);
      if (cur?.option === t.dataset.o) S.slip.delete(id);
      else S.slip.set(id, { option: t.dataset.o, boost: cur?.boost || null });
      S.cuponTab = 'cupon';
      renderMain();
      renderCupon();
      if (S.slip.size === 1 && window.matchMedia('(max-width: 860px)').matches) aviso('Sumado al cupón. Tocá “Cupón” para confirmar.');
      return;
    }
    if (t.dataset.quitar) { S.slip.delete(t.dataset.quitar); renderMain(); renderCupon(); return; }
    if (t.dataset.boost) {
      const it = S.slip.get(t.dataset.mid);
      it.boost = it.boost === t.dataset.boost ? null : t.dataset.boost;
      renderCupon();
      return;
    }
    if (t.dataset.tab) { S.cuponTab = t.dataset.tab; renderCupon(); return; }
    if (t.id === 'confirmar-cupon') return confirmarCupon();
    if (t.id === 'vaciar-cupon') { S.slip.clear(); renderMain(); renderCupon(); return; }
    if (t.dataset.accion === 'login') return modalLogin();
    if (t.dataset.comprar) return comprarComodin(t.dataset.comprar);
    if (t.dataset.premio) {
      const r = S.state.rewards.find((x) => x.id === t.dataset.premio);
      if (r) modalCanje(r);
      return;
    }
    if (t.dataset.periodo) { S.rankingPeriod = t.dataset.periodo; S.rankingRows = null; renderMain(); cargarRanking(); return; }
    if (t.id === 'boton-cupon') { $('#cupon').classList.toggle('abierto'); return; }
    if (t.hasAttribute('data-cerrar-cupon')) { $('#cupon').classList.remove('abierto'); return; }
  });

  // ---------- reloj (cuentas regresivas sin re-renderizar todo) ----------
  let ultimoAbiertos = -1;
  function tick() {
    if (!S.state) return;
    const t = serverNow();
    $$('[data-closes]').forEach((el) => {
      const resta = (Number(el.dataset.closes) - t) / 1000;
      el.textContent = mmss(resta);
      el.closest('.cierra')?.classList.toggle('urgente', resta < 30);
    });
    $$('[data-start]').forEach((el) => { el.textContent = mmss((t - Number(el.dataset.start)) / 1000); });
    const abiertos = (S.state.markets || []).filter((m) => m.status === 'open' && m.closes_at > t).length;
    if (abiertos !== ultimoAbiertos) {
      if (ultimoAbiertos !== -1) {
        for (const id of S.slip.keys()) {
          const m = S.state.markets.find((x) => x.id === id);
          if (!m || m.closes_at <= t) S.slip.delete(id);
        }
        renderMain();
        renderCupon();
        renderLateral();
      }
      ultimoAbiertos = abiertos;
    }
  }

  // ---------- ciclo de actualización ----------
  let ultimoSaldo = null;
  async function ciclo() {
    await refrescar();
    if (user()) {
      await cargarMe();
      const s = user()?.balance;
      if (ultimoSaldo !== null && s > ultimoSaldo) aviso(`+${fmt(s - ultimoSaldo)} fichas`, 'oro');
      ultimoSaldo = s ?? null;
      renderUsuario();
      renderLateral();
      if (S.route === 'jugadas' || S.route === 'vivo') renderMain();
      renderCupon();
    }
    setTimeout(ciclo, document.hidden ? 15000 : 4000);
  }

  function mensajesDeUrl() {
    const qs = new URLSearchParams(location.search);
    if (qs.get('ok') === 'login') aviso('¡Listo! Ya estás adentro.', 'oro');
    if (qs.get('ok') === 'vinculado') aviso('Cuenta vinculada. Tus fichas quedaron juntas.', 'oro');
    if (qs.get('error')) aviso(qs.get('error'), 'error');
    if (qs.has('ok') || qs.has('error')) history.replaceState(null, '', location.pathname + location.hash);
  }

  async function iniciar() {
    const qs = new URLSearchParams(location.search);
    demo = qs.has('demo') || location.protocol === 'file:' || !!window.GRIETA_DEMO;
    if (!demo) {
      try {
        const s = await api('GET', '/api/state');
        if (!s.ok) throw new Error();
      } catch {
        demo = true;
      }
    }
    if (demo) $('#banda-demo').classList.remove('hidden');
    await Promise.all([refrescar(), cargarMe()]);
    ultimoSaldo = user()?.balance ?? null;
    mensajesDeUrl();
    window.addEventListener('hashchange', route);
    route();
    setInterval(tick, 1000);
    setTimeout(ciclo, 4000);
  }

  iniciar();
})();
