// 组装 HTTP(S) 服务：静态资源 + REST + WebSocket。测试与 demo 脚本也通过它启动。
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, HttpError, readJson, sendJson, serveStatic } from './http.js';
import { Store } from './store.js';
import { registerApi } from './api.js';
import { attachRealtime } from './realtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const LEAFLET = path.join(ROOT, 'node_modules', 'leaflet', 'dist');

// 地图瓦片来自高德 / OSM / Esri，其余资源全部同源
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

export function createApp({ dataDir, tls = null, log = true } = {}) {
  dataDir = path.resolve(dataDir || path.join(ROOT, 'data'));
  const uploadsDir = path.join(dataDir, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'paddock.db'));

  const router = new Router();
  const ctx = { store, uploadsDir, rt: null };

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=()');
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const m = router.match(req.method, pathname);
      if (!m) return sendJson(res, 404, { error: '接口不存在' });
      try {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
        const user = store.userByToken(token);
        if (!m.handler.public && !user) throw new HttpError(401, '请先登录');
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req, m.handler.bodyLimit) : {};
        const result = await m.handler({
          req, res, params: m.params, query: Object.fromEntries(url.searchParams), body, user, token,
          ip: req.socket.remoteAddress,
        });
        return sendJson(res, 200, result);
      } catch (e) {
        if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
        console.error(e);
        return sendJson(res, 500, { error: '服务器内部错误' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    if (pathname.startsWith('/uploads/')) {
      if (await serveStatic(req, res, uploadsDir, pathname.slice(9), { maxAge: 86400 * 30 })) return;
    } else if (pathname.startsWith('/vendor/leaflet/')) {
      if (await serveStatic(req, res, LEAFLET, pathname.slice(16), { maxAge: 86400 })) return;
    } else {
      res.setHeader('Content-Security-Policy', CSP);
      if (await serveStatic(req, res, PUBLIC, pathname === '/' ? 'index.html' : pathname)) return;
      // 单页应用：未知路径回落到 index.html
      if (!path.extname(pathname) && (await serveStatic(req, res, PUBLIC, 'index.html'))) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  const server = tls
    ? https.createServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handle)
    : http.createServer(handle);
  ctx.rt = attachRealtime(server, store);
  registerApi(router, ctx);

  return {
    server,
    store,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address();
          if (log) console.log(`🏁 围场 Paddock 已启动：${tls ? 'https' : 'http'}://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}`);
          resolve(addr.port);
        });
      });
    },
    close() {
      ctx.rt.close();
      return new Promise((resolve) => server.close(() => {
        store.close();
        resolve();
      }));
    },
  };
}

/** 本机的局域网 IPv4 地址（手机连同一个 Wi-Fi 时用它访问）。 */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

/** 端口是否空闲（避免重复启动时报一大串错误）。 */
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

/** 用系统默认浏览器打开网址。 */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* 打不开就算了，用户可以手动输入网址 */
  }
}
