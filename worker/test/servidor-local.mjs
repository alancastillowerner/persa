// Servidor de prueba local: corre el Worker con SQLite en disco y sirve /public.
// Uso: node --no-warnings worker/test/servidor-local.mjs [puerto]
// Panel: http://localhost:8788/panel.html (contraseña: local)  ·  Login de prueba: /auth/dev?name=Ana
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1 } from './d1-local.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '../../public');
const worker = (await import(path.join(here, '../src/index.js'))).default;
const port = Number(process.argv[2] || 8788);
const env = {
  DB: createD1(path.join(here, '../schema.sql'), process.env.DB_FILE || path.join(here, 'local.sqlite')),
  DEV_MODE: '1',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'local',
  PUBLIC_URL: `http://localhost:${port}`,
};
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.exe': 'application/octet-stream', '.ico': 'image/x-icon' };

async function estatico(url) {
  let p = decodeURIComponent(new URL(url).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(pub, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(pub)) return new Response('no', { status: 403 });
  try {
    return new Response(await readFile(file), { headers: { 'content-type': tipos[path.extname(file)] || 'application/octet-stream' } });
  } catch {
    return new Response('No encontrado', { status: 404 });
  }
}
env.ASSETS = { fetch: (req) => estatico(req.url) };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const waits = [];
  const r = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p) });
  const headers = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = r.headers.getSetCookie().map((c) => c.replace('; Secure', ''));
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`Grieta local en http://localhost:${port}  (panel: /panel.html, contraseña "${env.ADMIN_PASSWORD}")`));

setInterval(() => worker.scheduled({}, env, { waitUntil: () => {} }).catch(() => {}), 60_000);
