// 启动入口：npm start
// 环境变量：PORT（默认 3000）、HOST（默认 0.0.0.0）、DATA_DIR（默认 ./data）、
//           TLS_CERT / TLS_KEY（提供后以 HTTPS 启动，手机在局域网内使用定位与麦克风需要 HTTPS）
import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: process.env.TLS_CERT, key: process.env.TLS_KEY } : null;

const app = createApp({ dataDir: process.env.DATA_DIR, tls });
await app.listen(port, host);

if (host === '0.0.0.0') {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`   局域网访问：${tls ? 'https' : 'http'}://${n.address}:${port}`);
    }
  }
  if (!tls) console.log('   提示：手机通过局域网 IP 访问时，浏览器只在 HTTPS 下允许定位和麦克风，详见 README「手机上使用」。');
}

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
