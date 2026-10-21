/* La Grieta del Persa — overlays para OBS / Streamlabs (fuente de navegador 1920x1080) */
(() => {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const tipo = qs.get('tipo') || 'completo';
  const previa = qs.has('previa');
  let demo = qs.has('demo');
  if (qs.has('fondo')) document.body.classList.add('fondo');
  const ver = {
    pronostico: tipo === 'pronostico' || tipo === 'completo',
    alertas: tipo === 'alertas' || tipo === 'completo',
    ranking: tipo === 'ranking',
    invitacion: tipo === 'completo',
  };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('es-AR');
  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
  const host = location.host.replace(/^www\./, '');

  let S = null;
  let skew = 0;
  let ultimoFeed = null;
  let rotar = 0;
  const cola = [];
  let mostrando = false;
  const now = () => Date.now() + skew;

  async function estado() {
    if (!demo) {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        if (!(r.headers.get('content-type') || '').includes('json')) throw new Error();
        return await r.json();
      } catch {
        demo = true;
      }
    }
    return window.GrietaDemo.handle('GET', '/api/state');
  }

  // ---------- pronóstico abierto ----------
  function tarjetaPronostico() {
    const el = $('#pronostico');
    if (!ver.pronostico) return;
    let ms = (S.markets || []).filter((m) => m.status === 'open' && m.closes_at > now());
    const recientes = (S.markets || []).filter((m) => m.status === 'resolved' && m.total > 0 && now() - m.resolved_at < 15_000);
    if (!ms.length && !recientes.length && previa && window.GrietaDemo) {
      return; // la previa pide datos de ejemplo en refrescar()
    }
    if (recientes.length) {
      const m = recientes[0];
      const o = m.options.find((x) => x.key === m.outcome);
      el.innerHTML = `
        <div class="cab"><svg><use href="#emblema"/></svg>Resultado</div>
        <div class="preg">${esc(m.question)}</div>
        <div class="ops">${m.options.map((x) => `<div class="op ${x.key === m.outcome ? 'gano' : ''}"><div class="relleno" style="width:${x.pct}%"></div><span>${esc(x.label)}</span><b class="num">${x.pct}%</b></div>`).join('')}</div>
        <div class="pie"><span>Salió <b>${esc(o?.label || '')}</b></span><span>Acertó el <b class="num">${o?.pct ?? 0}%</b></span></div>`;
      el.classList.remove('oculto');
      return;
    }
    if (!ms.length) { el.classList.add('oculto'); return; }
    ms = ms.sort((a, b) => a.closes_at - b.closes_at);
    const m = ms[Math.floor(rotar / 8) % ms.length];
    const resta = (m.closes_at - now()) / 1000;
    el.innerHTML = `
      <div class="cab"><svg><use href="#emblema"/></svg>Pronóstico abierto${ms.length > 1 ? ` (${(Math.floor(rotar / 8) % ms.length) + 1} de ${ms.length})` : ''}<span class="reloj num ${resta < 30 ? 'urgente' : ''}" data-closes="${m.closes_at}">${mmss(resta)}</span></div>
      <div class="preg">${esc(m.question)}</div>
      <div class="ops">${m.options.map((x) => `<div class="op"><div class="relleno" style="width:${x.pct}%"></div><span>${esc(x.label)}</span><b class="num">${x.pct}%</b><i class="num">x${x.odds.toFixed(2)}</i></div>`).join('')}</div>
      <div class="pie"><span>Pronosticá gratis en <b>${esc(host)}</b></span><span class="num">${fmt(m.total)} jugadas</span></div>`;
    el.classList.remove('oculto');
  }

  // ---------- ranking ----------
  function tarjetaRanking() {
    if (!ver.ranking) return;
    const el = $('#ranking');
    const rows = (S.leaderboard || []).slice(0, 5);
    el.innerHTML = `<div class="cab"><svg><use href="#emblema"/></svg>Ranking del mes</div>
      <ol>${rows.map((r, i) => `<li><span class="p num">${i + 1}</span><span class="n">${esc(r.name)}</span><span class="v num">${fmt(r.won)}</span></li>`).join('') || '<li><span></span><span class="n" style="color:var(--niebla)">Todavía sin ranking</span><span></span></li>'}</ol>`;
    el.classList.remove('oculto');
  }

  // ---------- invitación ----------
  function tarjetaInvitacion() {
    if (!ver.invitacion) return;
    const el = $('#invitacion');
    const abierto = (S.markets || []).some((m) => m.status === 'open' && m.closes_at > now());
    el.innerHTML = `<svg><use href="#emblema"/></svg><div>${esc(S.profile?.site || 'La Grieta')}<small>Pronosticá gratis y canjeá premios en ${esc(host)}</small></div>`;
    el.classList.toggle('oculto', abierto);
  }

  // ---------- alertas ----------
  function nuevasAlertas() {
    if (!ver.alertas) return;
    const feed = S.feed || [];
    if (ultimoFeed === null) { ultimoFeed = feed[0]?.id ?? 0; return; }
    const nuevas = feed.filter((f) => f.id > ultimoFeed && ['carga', 'premio', 'regalo'].includes(f.kind)).reverse();
    if (feed[0]) ultimoFeed = Math.max(ultimoFeed, feed[0].id);
    cola.push(...nuevas);
    if (!mostrando) siguienteAlerta();
  }

  function siguienteAlerta() {
    const f = cola.shift();
    if (!f) { mostrando = false; return; }
    mostrando = true;
    const el = document.createElement('div');
    el.className = 'alerta';
    const titulo = f.kind === 'carga' ? `+${fmt(f.amount)} ${f.amount === 1 ? 'ficha' : 'fichas'}` : f.kind === 'premio' ? '¡Premio canjeado!' : `+${fmt(f.amount)} fichas de regalo`;
    el.innerHTML = `<div class="ico"><svg><use href="#${f.kind === 'premio' ? 'regalo' : 'ficha'}"/></svg></div><div>${esc(titulo)}<small>${esc(f.text)}</small></div>`;
    $('#alertas').appendChild(el);
    setTimeout(() => el.classList.add('sale'), 5600);
    setTimeout(() => { el.remove(); siguienteAlerta(); }, 6100);
  }

  async function refrescar() {
    try {
      let s = await estado();
      if (previa && !(s.markets || []).some((m) => m.status === 'open') && window.GrietaDemo) {
        const d = await window.GrietaDemo.handle('GET', '/api/state');
        s = { ...s, markets: d.markets, leaderboard: s.leaderboard && s.leaderboard.length ? s.leaderboard : d.leaderboard };
      }
      S = s;
      skew = s.server_time - Date.now();
      tarjetaPronostico();
      tarjetaRanking();
      tarjetaInvitacion();
      nuevasAlertas();
    } catch { /* reintenta */ }
  }

  setInterval(() => {
    rotar++;
    document.querySelectorAll('[data-closes]').forEach((el) => {
      const resta = (Number(el.dataset.closes) - now()) / 1000;
      el.textContent = mmss(resta);
      el.classList.toggle('urgente', resta < 30);
    });
    if (rotar % 8 === 0 && S) tarjetaPronostico();
  }, 1000);
  refrescar();
  setInterval(refrescar, 3000);
})();
