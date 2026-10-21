/* La Grieta del Persa — panel del streamer */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('es-AR');
  const hace = (t) => {
    if (!t) return 'nunca';
    const d = (Date.now() - t) / 1000;
    if (d < 60) return `hace ${Math.max(1, Math.round(d))} s`;
    if (d < 3600) return `hace ${Math.round(d / 60)} min`;
    if (d < 86400) return `hace ${Math.round(d / 3600)} h`;
    return new Date(t).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

  const TABS = [
    ['resumen', 'Resumen'], ['partida', 'Partida y pronósticos'], ['canjes', 'Canjes'], ['premios', 'Premios'],
    ['usuarios', 'Usuarios'], ['conexiones', 'Conexiones'], ['overlays', 'Overlays para OBS'], ['ajustes', 'Ajustes'],
  ];
  let O = null; // overview
  let tab = 'resumen';
  let ultimoCodigo = null;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json', 'x-grieta': '1' } : {},
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({ ok: false, error: `Error ${res.status}` }));
    if (res.status === 401 && path !== '/api/admin/login') { O = null; renderLogin(); }
    return data;
  }

  function aviso(texto, tipo = '') {
    const el = document.createElement('div');
    el.className = `aviso ${tipo}`;
    el.textContent = texto;
    $('#avisos').appendChild(el);
    setTimeout(() => el.remove(), tipo === 'error' ? 7000 : 4000);
  }

  function renderLogin() {
    $('#app').innerHTML = `
      <form class="login-box" id="f-login">
        <svg aria-hidden="true"><use href="#emblema"/></svg>
        <h1>Panel del streamer</h1>
        <p class="muted" style="margin:0">Entrá con la contraseña que configuraste en Cloudflare (ADMIN_PASSWORD).</p>
        <label class="muted" style="display:flex;flex-direction:column;gap:6px;font-size:13px">Contraseña<input class="campo" type="password" id="pass" autocomplete="current-password" autofocus required></label>
        <button class="btn oro ancho" type="submit">Entrar al panel</button>
        <a class="muted" href="/" style="font-size:13px;text-align:center">Volver a la web</a>
      </form>`;
    $('#f-login').onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('POST', '/api/admin/login', { password: $('#pass').value });
      if (!r.ok) return aviso(r.error, 'error');
      await cargar();
    };
  }

  async function cargar() {
    const r = await api('GET', '/api/admin/overview');
    if (!r.ok) return;
    O = r;
    render();
  }

  function shell(contenido) {
    const pend = O.stats.pending_orders;
    return `
      <header class="top">
        <a class="marca" href="/" title="Ver la web"><svg aria-hidden="true"><use href="#emblema"/></svg>
          <span><b>${esc(O.config.profile.site)}</b><small>Panel del streamer</small></span></a>
        <div class="der">
          <a class="btn fantasma chico" href="/" target="_blank" rel="noopener">Ver la web</a>
          <button class="btn chico" id="salir">Salir</button>
        </div>
      </header>
      <div class="p-layout">
        <nav class="p-nav" aria-label="Secciones del panel">
          ${TABS.map(([k, t]) => `<a href="#${k}" ${k === tab ? 'aria-current="page"' : ''}>${t}${k === 'canjes' && pend ? `<span class="badge">${pend}</span>` : ''}</a>`).join('')}
        </nav>
        <main class="p-main" id="contenido">${contenido}</main>
      </div>`;
  }

  // ---------- secciones ----------
  function estadoApp() {
    const a = O.app;
    if (!a.configured) return { txt: 'Sin configurar', cls: 'neutro' };
    if (a.last && Date.now() - a.last < 90_000) return { txt: a.in_game ? 'Conectado, en partida' : 'Conectado', cls: 'ok' };
    return { txt: a.last ? `Desconectado (${hace(a.last)})` : 'Nunca se conectó', cls: 'mal' };
  }

  function vResumen() {
    const ap = estadoApp();
    const k = O.kick;
    const t = O.twitch;
    const riot = O.config.riot;
    const pasos = [
      [true, 'Web publicada y base de datos lista', 'Si estás viendo esto, ya está.'],
      [!!k, 'Conectar el canal de Kick', 'Para crear las recompensas de puntos de canal.', '#conexiones'],
      [!!(k && k.rewards && k.rewards.length), 'Crear las recompensas "Cargar fichas" en Kick', `${O.config.economy.points_per_ficha} puntos = 1 ficha.`, '#conexiones'],
      [!!t || !O.env.twitch_app, 'Conectar Twitch (opcional)', O.env.twitch_app ? 'Si también hacés stream en Twitch.' : 'No configuraste una app de Twitch: se omite.', '#conexiones'],
      [O.app.configured, 'Generar el código del conector de PC', 'Para los pronósticos en vivo y la detección automática.', '#conexiones'],
      [!!riot.game_name || !O.env.riot_key, 'Cargar tu Riot ID (opcional)', O.env.riot_key ? 'Detecta partidas aunque la app esté cerrada.' : 'Sin clave de Riot: la detección queda a cargo de la app.', '#conexiones'],
      [false, 'Sumar los overlays a OBS o Streamlabs', 'Copiá los links de la sección Overlays.', '#overlays'],
    ];
    return `
      <h1>Resumen</h1>
      <div class="tarjetas">
        <div class="tarj"><span>Conector de PC</span><b class="${ap.cls}" style="font-size:17px">${ap.txt}</b></div>
        <div class="tarj"><span>Kick</span><b class="${k ? 'ok' : 'neutro'}" style="font-size:17px">${k ? `Conectado: ${esc(k.name)}` : 'Sin conectar'}</b></div>
        <div class="tarj"><span>Twitch</span><b class="${t ? 'ok' : 'neutro'}" style="font-size:17px">${t ? `Conectado: ${esc(t.name)}` : 'Sin conectar'}</b></div>
        <div class="tarj"><span>Partida</span><b style="font-size:17px">${O.game ? `En curso${O.game.champion ? ` con ${esc(O.game.champion)}` : ''}` : 'Fuera de partida'}</b></div>
        <div class="tarj"><span>Viewers registrados</span><b>${fmt(O.stats.users)}</b></div>
        <div class="tarj"><span>Fichas en circulación</span><b>${fmt(O.stats.circulating)}</b></div>
        <div class="tarj"><span>Canjes por cumplir</span><b class="${O.stats.pending_orders ? '' : 'neutro'}">${fmt(O.stats.pending_orders)}</b>${O.stats.pending_orders ? '<a href="#canjes" style="font-size:13px">Ver canjes</a>' : ''}</div>
      </div>
      <section class="panel"><header><h2>Puesta en marcha</h2></header>
        <ol class="checklist">${pasos.map(([ok, titulo, sub, link], i) => `<li class="${ok ? 'hecho' : ''}"><span class="dot">${ok ? '✓' : i + 1}</span>
          <div>${esc(titulo)}<small>${esc(sub)}</small></div>${!ok && link ? `<a class="btn chico" href="${link}">Ir</a>` : '<span></span>'}</li>`).join('')}</ol>
      </section>`;
  }

  function vPartida() {
    const g = O.game;
    const abiertos = O.markets.filter((m) => m.status === 'open' || m.status === 'closed');
    const resueltos = O.markets.filter((m) => m.status === 'resolved' || m.status === 'void');
    const fila = (m) => {
      const abierto = m.status === 'open' && m.closes_at > Date.now();
      return `<div class="fila-mercado"><div><b>${esc(m.question)}</b>
        <div class="muted" style="font-size:13px">${m.status === 'resolved' ? `Resultado: ${esc(m.options.find((o) => o.key === m.outcome)?.label)}` : m.status === 'void' ? 'Anulado' : abierto ? `Cierra en ${mmss((m.closes_at - Date.now()) / 1000)}` : 'Cerrado, esperando resultado'}
        · ${m.options.map((o) => `${esc(o.label)} ${o.count} (${o.pct}%)`).join(' / ')}</div></div>
        <div class="opts">${m.status === 'open' || m.status === 'closed' ? `
          ${abierto ? `<button class="btn chico" data-cerrar="${m.id}">Cerrar ya</button>` : ''}
          ${m.options.map((o) => `<button class="btn chico" data-resolver="${m.id}" data-out="${o.key}">Salió: ${esc(o.label)}</button>`).join('')}
          <button class="btn chico peligro" data-resolver="${m.id}" data-out="void">Anular</button>` : ''}</div></div>`;
    };
    return `
      <h1>Partida y pronósticos</h1>
      <p class="intro">Los pronósticos de la partida se crean y se resuelven solos. Usá esta sección para corregir algo a mano o crear pronósticos especiales.</p>
      <section class="panel"><header><h2>${g ? `En partida${g.champion ? ` con ${esc(g.champion)}` : ''}` : 'Fuera de partida'}</h2>
        ${g ? `<span class="extra">${g.source === 'app' ? 'Datos de la app de PC' : 'Datos de la API de Riot'} · ${fmt(g.kills)}/${fmt(g.deaths)}/${fmt(g.assists)}</span>` : ''}</header>
        ${g ? `<div class="cuerpo acciones"><button class="btn peligro chico" id="anular-partida">Anular partida (devuelve los pronósticos)</button></div>` : '<div class="cuerpo muted">Cuando entres a una partida, los pronósticos se abren solos.</div>'}
      </section>
      <section class="panel"><header><h2>Abiertos y esperando resultado</h2></header>${abiertos.map(fila).join('') || '<div class="cuerpo muted">No hay pronósticos abiertos.</div>'}</section>
      <section class="panel"><header><h2>Crear pronóstico especial</h2></header>
        <form class="form" id="f-especial">
          <label class="ancho-total">Pregunta<input class="campo" name="question" maxlength="120" placeholder="¿Hace un pentakill en el stream de hoy?" required></label>
          <label>Opción 1<input class="campo" name="o1" value="Sí" required></label>
          <label>Opción 2<input class="campo" name="o2" value="No" required></label>
          <label>Opción 3 (opcional)<input class="campo" name="o3"></label>
          <label>Cierra en (minutos)<input class="campo" name="minutes" type="number" min="0.5" max="120" step="0.5" value="3"></label>
          <label>Premio base<input class="campo" name="base" type="number" min="1" value="${O.config.economy.base_reward}"></label>
          <div class="acciones ancho-total"><button class="btn oro" type="submit">Abrir pronóstico</button><span class="muted" style="font-size:13px">Lo resolvés vos desde esta sección.</span></div>
        </form>
      </section>
      ${resueltos.length ? `<section class="panel"><header><h2>Resueltos recientemente</h2></header>${resueltos.map(fila).join('')}</section>` : ''}`;
  }

  async function vCanjes(filtro = 'pendiente') {
    const r = await api('GET', `/api/admin/orders?status=${filtro}`);
    const est = { pendiente: 'Pendiente', cumplido: 'Cumplido', devuelto: 'Devuelto' };
    return `
      <h1>Canjes de premios</h1>
      <p class="intro">Cuando cumplas un premio en el stream, marcalo como cumplido. Si no se puede cumplir, devolvé las fichas.</p>
      <div class="acciones"><button class="btn chico ${filtro === 'pendiente' ? 'oro' : ''}" data-filtro="pendiente">Por cumplir</button><button class="btn chico ${filtro === 'todos' ? 'oro' : ''}" data-filtro="todos">Todos</button></div>
      <section class="panel">${r.orders && r.orders.length ? `<div style="overflow:auto"><table class="tabla"><thead><tr><th>Viewer</th><th>Premio</th><th>Dato</th><th>Cuándo</th><th></th></tr></thead><tbody>
        ${r.orders.map((o) => `<tr><td><b>${esc(o.user_name)}</b><div class="muted" style="font-size:12px">${[o.kick_username && `Kick: ${esc(o.kick_username)}`, o.twitch_login && `Twitch: ${esc(o.twitch_login)}`].filter(Boolean).join(' / ')}</div></td>
          <td>${esc(o.reward_name)}<div class="muted num" style="font-size:12px">${fmt(o.cost)} fichas</div></td><td>${esc(o.note || '')}</td><td class="muted">${hace(o.created_at)}</td>
          <td>${o.status === 'pendiente' ? `<div class="acciones"><button class="btn chico oro" data-orden="${o.id}" data-st="cumplido">Cumplido</button><button class="btn chico peligro" data-orden="${o.id}" data-st="devuelto">Devolver fichas</button></div>` : est[o.status]}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="cuerpo muted">No hay canjes en esta lista.</div>'}</section>`;
  }

  async function vPremios() {
    const r = await api('GET', '/api/admin/rewards');
    const iconos = ['mic', 'star', 'crown', 'sword', 'gem', 'eye', 'shield', 'gift'];
    const filaP = (p) => `<tr data-id="${esc(p.id || '')}">
      <td><input class="campo" name="name" value="${esc(p.name || '')}" maxlength="60" placeholder="Nombre"><input class="campo" name="description" value="${esc(p.description || '')}" maxlength="200" placeholder="Descripción" style="margin-top:6px"></td>
      <td><input class="campo" name="cost" type="number" min="1" value="${p.cost || ''}" style="width:100px"></td>
      <td><input class="campo" name="stock" type="number" min="0" value="${p.stock ?? ''}" placeholder="Ilimitado" style="width:110px"></td>
      <td><select class="campo" name="icon">${iconos.map((i) => `<option ${p.icon === i ? 'selected' : ''}>${i}</option>`).join('')}</select></td>
      <td><label class="check" style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" name="needs_note" ${p.needs_note ? 'checked' : ''}>Pide dato</label>
        <input class="campo" name="note_hint" value="${esc(p.note_hint || '')}" placeholder="¿Qué dato?" style="margin-top:6px"></td>
      <td><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" name="active" ${p.active !== 0 ? 'checked' : ''}>Visible</label></td>
      <td><div class="acciones"><button class="btn chico oro" data-guardar-premio>Guardar</button>${p.id ? '<button class="btn chico peligro" data-borrar-premio>Borrar</button>' : ''}</div></td></tr>`;
    return `
      <h1>Premios de la tienda</h1>
      <p class="intro">Las fichas no tienen valor en dinero: mantené premios que no sean plata ni productos que se puedan revender (saludos, elegir campeón, jugar juntos, roles de Discord).</p>
      <section class="panel"><div style="overflow:auto"><table class="tabla"><thead><tr><th>Premio</th><th>Costo</th><th>Stock</th><th>Ícono</th><th>Dato</th><th></th><th></th></tr></thead>
        <tbody id="tb-premios">${(r.rewards || []).map(filaP).join('')}</tbody></table></div>
        <div class="cuerpo"><button class="btn" id="agregar-premio">Agregar premio</button></div></section>
      <template id="tpl-premio">${filaP({ icon: 'star', active: 1 })}</template>`;
  }

  async function vUsuarios(q = '') {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(q)}`);
    return `
      <h1>Usuarios</h1>
      <form class="acciones" id="f-buscar"><input class="campo" name="q" value="${esc(q)}" placeholder="Buscar por nombre" style="max-width:320px"><button class="btn">Buscar</button></form>
      <section class="panel"><div style="overflow:auto"><table class="tabla"><thead><tr><th>Viewer</th><th>Fichas</th><th>Aciertos</th><th>Desde</th><th></th></tr></thead><tbody>
        ${(r.users || []).map((u) => `<tr><td><b>${esc(u.name)}</b>${u.banned ? ' <span class="chip loss">Suspendido</span>' : ''}<div class="muted" style="font-size:12px">${[u.kick_username && `Kick: ${esc(u.kick_username)}`, u.twitch_login && `Twitch: ${esc(u.twitch_login)}`].filter(Boolean).join(' / ')}</div></td>
          <td class="num">${fmt(u.balance)}</td><td class="num">${u.picks_won}/${u.picks_total}</td><td class="muted">${new Date(u.created_at).toLocaleDateString('es-AR')}</td>
          <td><div class="acciones"><button class="btn chico" data-ajustar="${u.id}" data-nombre="${esc(u.name)}">Dar o quitar fichas</button>
            <button class="btn chico ${u.banned ? '' : 'peligro'}" data-ban="${u.id}" data-v="${u.banned ? 0 : 1}">${u.banned ? 'Reactivar' : 'Suspender'}</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin resultados.</td></tr>'}
      </tbody></table></div></section>
      ${r.pending && r.pending.length ? `<section class="panel"><header><h2>Canjes de puntos de gente sin registrarse</h2><span class="extra">Se acreditan cuando entran</span></header>
        <table class="tabla"><tbody>${r.pending.map((p) => `<tr><td>${esc(p.platform_name)}</td><td>${p.platform === 'kick' ? 'Kick' : 'Twitch'}</td><td class="num">${fmt(p.fichas)} fichas</td></tr>`).join('')}</tbody></table></section>` : ''}`;
  }

  function vConexiones() {
    const base = O.base_url;
    const plat = (key, nombre, data, appOk, secretos) => `
      <section class="panel"><header><h2>${nombre}</h2><span class="extra">${data ? `Conectado como ${esc(data.name)}` : 'Sin conectar'}</span></header>
        <div class="cuerpo" style="display:flex;flex-direction:column;gap:12px">
          ${!appOk ? `<p class="muted" style="margin:0">Primero creá la app de ${nombre} y cargá ${secretos} en Cloudflare (ver la guía LEEME). Redirect URL: <code>${esc(base)}/auth/${key}/callback</code></p>` : `
          <p class="muted" style="margin:0">Conectá la cuenta del canal (la de ${esc(O.config.profile.name)}). Después tocá "Crear recompensas": se crean ${O.config.economy.packs.map((n) => `"Cargar ${n} ${n === 1 ? 'ficha' : 'fichas'}"`).join(', ')} a ${fmt(O.config.economy.points_per_ficha)} puntos por ficha.</p>
          ${data && data.rewards && data.rewards.length ? `<div class="muted" style="font-size:13px">Recompensas activas: ${data.rewards.map((r) => `${r.fichas} ${r.fichas === 1 ? 'ficha' : 'fichas'} (${fmt(r.cost)} pts)`).join(', ')}</div>` : ''}
          ${key === 'twitch' && data && data.revoked ? '<div class="aviso error" style="animation:none">Twitch cortó la suscripción a canjes. Tocá "Crear recompensas" de nuevo.</div>' : ''}
          ${key === 'kick' ? `<p class="muted" style="margin:0;font-size:13px">En la app de Kick (kick.com/settings/developer) activá "Enable Webhooks" con esta URL: <code>${esc(base)}/webhooks/kick</code></p>` : ''}
          <div class="acciones">
            <a class="btn ${data ? '' : 'oro'}" href="/auth/${key}?mode=broadcaster">${data ? 'Reconectar' : `Conectar canal de ${nombre}`}</a>
            ${data ? `<button class="btn oro" data-setup="${key}">${data.rewards && data.rewards.length ? 'Actualizar recompensas' : 'Crear recompensas'}</button><button class="btn peligro chico" data-desconectar="${key}">Desconectar</button>` : ''}
          </div>
          <ul class="log hidden" id="log-${key}"></ul>`}
        </div></section>`;
    const ap = estadoApp();
    const riot = O.config.riot;
    return `
      <h1>Conexiones</h1>
      ${plat('kick', 'Kick', O.kick, O.env.kick_app, 'KICK_CLIENT_ID y KICK_CLIENT_SECRET')}
      ${plat('twitch', 'Twitch', O.twitch, O.env.twitch_app && O.env.twitch_secret, 'TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET y TWITCH_EVENTSUB_SECRET')}
      <section class="panel"><header><h2>Conector de PC</h2><span class="extra ${ap.cls}">${ap.txt}</span></header>
        <div class="cuerpo" style="display:flex;flex-direction:column;gap:12px">
          <p class="muted" style="margin:0">Una app chica para tu PC: no se instala, solo se abre. Lee los datos de la partida en vivo directo de League of Legends y los manda a la web. Habilita los pronósticos de primeros minutos (primera sangre, muerte antes del 10, primer dragón).</p>
          <ol class="instr"><li>Descargá <b>GrietaConector.exe</b> y guardalo donde quieras.</li><li>Generá el código de conexión y copialo.</li><li>Abrí la app, pegá el código y tocá Conectar. Listo: queda funcionando sola.</li></ol>
          <div class="acciones"><a class="btn oro" href="/descargas/GrietaConector.exe" download>Descargar GrietaConector.exe</a>
            <button class="btn" id="nuevo-codigo">${O.app.configured ? 'Generar un código nuevo' : 'Generar código de conexión'}</button></div>
          ${ultimoCodigo ? `<div class="codigo" id="codigo">${esc(ultimoCodigo)}</div><div class="acciones"><button class="btn chico" id="copiar-codigo">Copiar código</button><span class="muted" style="font-size:13px">Guardalo: por seguridad no se vuelve a mostrar. Si generás otro, el anterior deja de funcionar.</span></div>` : ''}
        </div></section>
      <section class="panel"><header><h2>Riot Games</h2><span class="extra">${O.env.riot_key ? (riot.puuid ? 'Cuenta verificada' : 'Falta el Riot ID') : 'Sin clave de API'}</span></header>
        <form class="form" id="f-riot">
          <p class="muted ancho-total" style="margin:0">Opcional. Con tu Riot ID, la web detecta tus partidas aunque la app de PC esté cerrada (solo pronósticos de resultado) y confirma resultados si la app se corta.${O.env.riot_key ? '' : ' Necesitás cargar RIOT_API_KEY en Cloudflare.'}</p>
          <label>Nombre de invocador<input class="campo" name="game_name" value="${esc(riot.game_name)}" placeholder="El Persa"></label>
          <label>Tag (sin #)<input class="campo" name="tag_line" value="${esc(riot.tag_line)}" placeholder="LAS"></label>
          <label>Servidor<select class="campo" name="platform">${[['la2', 'LAS'], ['la1', 'LAN'], ['br1', 'Brasil'], ['na1', 'Norteamérica'], ['euw1', 'EUW']].map(([v, t]) => `<option value="${v}" ${riot.platform === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <div class="acciones ancho-total"><button class="btn oro">Guardar Riot ID</button></div>
        </form></section>`;
  }

  function vOverlays() {
    const base = O.base_url;
    const items = [
      ['pronostico', 'Pronóstico en vivo', 'Muestra el pronóstico que está abierto con la cuenta regresiva y cómo vota el chat. Al resolverse, muestra el resultado unos segundos. Ideal abajo a la derecha.'],
      ['alertas', 'Alertas de la comunidad', 'Aparece cuando alguien carga fichas con puntos de canal o canjea un premio.'],
      ['ranking', 'Ranking del mes', 'El top 5 de la comunidad. Queda bien en pantallas de espera o en el costado.'],
      ['completo', 'Todo junto', 'Pronóstico, alertas y una invitación a entrar a la web, en una sola fuente.'],
    ];
    return `
      <h1>Overlays para OBS y Streamlabs</h1>
      <p class="intro">Cada overlay es un link. En OBS: Fuentes, +, <b>Navegador</b>, pegá la URL, ancho 1920 y alto 1080. En Streamlabs: <b>Browser Source</b> con los mismos datos. El fondo es transparente.</p>
      <div class="acciones"><button class="btn chico" data-probar="carga">Probar alerta de carga</button><button class="btn chico" data-probar="premio">Probar alerta de premio</button></div>
      <section class="panel">${items.map(([k, t, d]) => `<div class="overlay-item"><div><h3>${t}</h3><p>${d}</p>
        <div class="codigo">${esc(base)}/overlay.html?tipo=${k}</div>
        <div class="acciones" style="margin-top:8px"><button class="btn chico" data-copiar="${esc(base)}/overlay.html?tipo=${k}">Copiar link</button><a class="btn chico fantasma" href="/overlay.html?tipo=${k}&fondo=1" target="_blank" rel="noopener">Abrir</a></div></div>
        <div class="previa"><iframe src="/overlay.html?tipo=${k}&previa=1" title="Vista previa: ${t}" loading="lazy"></iframe></div></div>`).join('')}</section>`;
  }

  function vAjustes() {
    const p = O.config.profile;
    const e = O.config.economy;
    const m = O.config.markets;
    const chk = (n, v, t) => `<label class="check"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}>${t}</label>`;
    return `
      <h1>Ajustes</h1>
      <form id="f-ajustes" style="display:flex;flex-direction:column;gap:18px">
        <section class="panel"><header><h2>Perfil</h2></header><div class="form">
          <label>Nombre del streamer<input class="campo" name="p.name" value="${esc(p.name)}"></label>
          <label>Nombre de la web<input class="campo" name="p.site" value="${esc(p.site)}"></label>
          <label class="ancho-total">Frase<input class="campo" name="p.tagline" value="${esc(p.tagline)}"></label>
          <label class="ancho-total">Foto (URL de imagen)<input class="campo" name="p.avatar" value="${esc(p.avatar)}"></label>
          <label>Canal de Kick<input class="campo" name="p.kick" value="${esc(p.kick)}"></label>
          <label>Canal de Twitch<input class="campo" name="p.twitch" value="${esc(p.twitch)}"></label>
          <label>Twitter / X<input class="campo" name="p.twitter" value="${esc(p.twitter)}"></label>
          <label>Invitación de Discord<input class="campo" name="p.discord" value="${esc(p.discord)}"></label>
          <label>Plataforma principal<select class="campo" name="p.main_platform"><option value="kick" ${p.main_platform === 'kick' ? 'selected' : ''}>Kick</option><option value="twitch" ${p.main_platform === 'twitch' ? 'selected' : ''}>Twitch</option></select></label>
        </div></section>
        <section class="panel"><header><h2>Fichas</h2></header><div class="form">
          <label>Puntos de canal por ficha<input class="campo" name="e.points_per_ficha" type="number" min="1" value="${e.points_per_ficha}"></label>
          <label>Packs de recompensas (fichas, separadas por coma)<input class="campo" name="e.packs" value="${e.packs.join(', ')}"></label>
          <label>Bono de bienvenida<input class="campo" name="e.welcome_bonus" type="number" min="0" value="${e.welcome_bonus}"></label>
          <label>Premio base por acierto<input class="campo" name="e.base_reward" type="number" min="1" value="${e.base_reward}"></label>
          <label>Costo del comodín Doble premio<input class="campo" name="e.comodin_x2" type="number" min="1" value="${e.comodin_x2}"></label>
          <label>Costo del comodín Escudo<input class="campo" name="e.comodin_escudo" type="number" min="1" value="${e.comodin_escudo}"></label>
          <p class="muted ancho-total" style="margin:0;font-size:13px">Si cambiás los puntos por ficha o los packs, después tocá "Actualizar recompensas" en Conexiones.</p>
        </div></section>
        <section class="panel"><header><h2>Pronósticos automáticos</h2></header><div class="form">
          ${chk('m.win', m.win, '¿Gana la partida?')}
          ${chk('m.kills', m.kills, 'Kills (más o menos)')}<label>Línea de kills<input class="campo" name="m.kills_line" type="number" step="0.5" value="${m.kills_line}"></label>
          ${chk('m.deaths', m.deaths, 'Muertes (más o menos)')}<label>Línea de muertes<input class="campo" name="m.deaths_line" type="number" step="0.5" value="${m.deaths_line}"></label>
          ${chk('m.duration', m.duration, 'Duración de la partida')}<label>Minutos<input class="campo" name="m.duration_line" type="number" min="15" max="60" value="${m.duration_line}"></label>
          <label>Cierre de los de partida (segundos de juego)<input class="campo" name="m.pregame_close" type="number" min="60" max="900" value="${m.pregame_close}"></label>
          ${chk('m.firstblood', m.firstblood, 'Primera sangre (app)')}
          ${chk('m.death10', m.death10, 'Muere antes del minuto 10 (app)')}
          ${chk('m.firstdragon', m.firstdragon, 'Primer dragón (app)')}
        </div></section>
        <div class="acciones"><button class="btn oro">Guardar ajustes</button></div>
      </form>`;
  }

  // ---------- render y eventos ----------
  async function render() {
    if (!O) return renderLogin();
    const vistas = { resumen: vResumen, partida: vPartida, canjes: () => vCanjes(), premios: vPremios, usuarios: () => vUsuarios(), conexiones: vConexiones, overlays: vOverlays, ajustes: vAjustes };
    const html = await (vistas[tab] || vResumen)();
    $('#app').innerHTML = shell(html);
    $('#salir').onclick = async () => { await api('POST', '/api/admin/logout'); O = null; renderLogin(); };
  }

  async function guardarAjustes(form) {
    const body = { profile: {}, economy: {}, markets: {} };
    for (const el of form.elements) {
      if (!el.name) continue;
      const [grp, k] = el.name.split('.');
      const tgt = { p: body.profile, e: body.economy, m: body.markets }[grp];
      tgt[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    const r = await api('POST', '/api/admin/settings', body);
    if (!r.ok) return aviso(r.error, 'error');
    aviso('Ajustes guardados.', 'oro');
    await cargar();
  }

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'f-ajustes') { e.preventDefault(); return guardarAjustes(f); }
    if (f.id === 'f-riot') {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const r = await api('POST', '/api/admin/settings', { riot: d });
      if (!r.ok) return aviso(r.error, 'error');
      aviso('Riot ID guardado.', 'oro');
      return cargar();
    }
    if (f.id === 'f-especial') {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const r = await api('POST', '/api/admin/market', { action: 'create', question: d.question, options: [d.o1, d.o2, d.o3].filter(Boolean), minutes: d.minutes, base: d.base });
      if (!r.ok) return aviso(r.error, 'error');
      aviso('Pronóstico especial abierto.', 'oro');
      return cargar();
    }
    if (f.id === 'f-buscar') {
      e.preventDefault();
      const html = await vUsuarios(new FormData(f).get('q'));
      $('#contenido').innerHTML = html;
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.resolver) {
      const label = b.textContent.trim();
      if (!confirm(`¿Confirmás "${label}"? Se pagan los premios y no se puede deshacer.`)) return;
      const r = await api('POST', '/api/admin/market', { action: 'resolve', id: b.dataset.resolver, outcome: b.dataset.out });
      if (!r.ok) aviso(r.error, 'error'); else aviso('Pronóstico resuelto.', 'oro');
      return cargar();
    }
    if (b.dataset.cerrar) { await api('POST', '/api/admin/market', { action: 'close', id: b.dataset.cerrar }); return cargar(); }
    if (b.id === 'anular-partida') {
      if (!confirm('¿Anular la partida? Se devuelven todos los pronósticos pendientes.')) return;
      await api('POST', '/api/admin/market', { action: 'void_game' });
      aviso('Partida anulada.');
      return cargar();
    }
    if (b.dataset.filtro) { $('#contenido').innerHTML = await vCanjes(b.dataset.filtro); return; }
    if (b.dataset.orden) {
      if (b.dataset.st === 'devuelto' && !confirm('¿Devolver las fichas a este viewer?')) return;
      const r = await api('POST', '/api/admin/orders', { id: b.dataset.orden, status: b.dataset.st });
      if (!r.ok) aviso(r.error, 'error'); else aviso(b.dataset.st === 'cumplido' ? 'Marcado como cumplido.' : 'Fichas devueltas.', 'oro');
      return cargar();
    }
    if (b.hasAttribute('data-guardar-premio') || b.hasAttribute('data-borrar-premio')) {
      const tr = b.closest('tr');
      const v = (n) => tr.querySelector(`[name="${n}"]`);
      const body = b.hasAttribute('data-borrar-premio') ? { id: tr.dataset.id, delete: true } : {
        id: tr.dataset.id || undefined, name: v('name').value, description: v('description').value, cost: v('cost').value, stock: v('stock').value,
        icon: v('icon').value, needs_note: v('needs_note').checked, note_hint: v('note_hint').value, active: v('active').checked,
      };
      if (body.delete && !confirm('¿Borrar este premio?')) return;
      const r = await api('POST', '/api/admin/rewards', body);
      if (!r.ok) return aviso(r.error, 'error');
      aviso(body.delete ? 'Premio borrado.' : 'Premio guardado.', 'oro');
      return render();
    }
    if (b.id === 'agregar-premio') { $('#tb-premios').insertAdjacentHTML('beforeend', $('#tpl-premio').innerHTML); return; }
    if (b.dataset.ajustar) {
      const n = prompt(`¿Cuántas fichas le das a ${b.dataset.nombre}? (negativo para quitar)`);
      if (!n || !parseInt(n, 10)) return;
      const motivo = prompt('Motivo (lo ve el viewer en sus movimientos)', parseInt(n, 10) > 0 ? 'Regalo del streamer' : 'Ajuste del streamer') || '';
      const r = await api('POST', '/api/admin/users', { id: b.dataset.ajustar, delta: parseInt(n, 10), reason: motivo, announce: parseInt(n, 10) > 0 });
      if (!r.ok) return aviso(r.error, 'error');
      aviso('Fichas actualizadas.', 'oro');
      $('#contenido').innerHTML = await vUsuarios();
      return;
    }
    if (b.dataset.ban) {
      await api('POST', '/api/admin/users', { id: b.dataset.ban, banned: b.dataset.v === '1' });
      $('#contenido').innerHTML = await vUsuarios();
      return;
    }
    if (b.dataset.setup) {
      b.disabled = true;
      b.textContent = 'Creando…';
      const r = await api('POST', `/api/admin/${b.dataset.setup}/setup`);
      const log = $(`#log-${b.dataset.setup}`);
      if (!r.ok) { aviso(r.error, 'error'); b.disabled = false; b.textContent = 'Reintentar'; return; }
      await cargar();
      const log2 = $(`#log-${b.dataset.setup}`);
      if (log2) { log2.innerHTML = r.log.map((l) => `<li>${esc(l)}</li>`).join(''); log2.classList.remove('hidden'); }
      aviso('Recompensas listas.', 'oro');
      return;
    }
    if (b.dataset.desconectar) {
      if (!confirm('¿Desconectar el canal? Las recompensas de puntos dejan de acreditar fichas.')) return;
      await api('POST', `/api/admin/${b.dataset.desconectar}/disconnect`);
      return cargar();
    }
    if (b.id === 'nuevo-codigo') {
      if (O.app.configured && !confirm('El código anterior va a dejar de funcionar. ¿Generar uno nuevo?')) return;
      const r = await api('POST', '/api/admin/app-key');
      if (!r.ok) return aviso(r.error, 'error');
      ultimoCodigo = r.code;
      return cargar();
    }
    if (b.id === 'copiar-codigo' || b.dataset.copiar) {
      const txt = b.dataset.copiar || ultimoCodigo;
      try { await navigator.clipboard.writeText(txt); aviso('Copiado.'); } catch { prompt('Copiá esto:', txt); }
      return;
    }
    if (b.dataset.probar) { await api('POST', '/api/admin/test-alert', { kind: b.dataset.probar }); aviso('Alerta enviada a los overlays.'); }
  });

  window.addEventListener('hashchange', () => {
    tab = (location.hash || '#resumen').slice(1);
    render();
    window.scrollTo({ top: 0 });
  });

  const qs = new URLSearchParams(location.search);
  if (qs.get('ok')) aviso(`Canal de ${qs.get('ok') === 'kick' ? 'Kick' : 'Twitch'} conectado. Ahora creá las recompensas.`, 'oro');
  if (qs.get('error') === 'sesion') aviso('Tu sesión del panel venció. Entrá de nuevo.', 'error');
  if (qs.has('ok') || qs.has('error')) history.replaceState(null, '', location.pathname + location.hash);
  tab = (location.hash || '#resumen').slice(1);
  cargar();
  setInterval(() => { if (O && (tab === 'resumen' || tab === 'partida') && !document.hidden && !document.activeElement?.matches('input, select, textarea')) cargar(); }, 10000);
})();
