import { createHash } from 'node:crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { startJobSweeper } from './jobs/store.js';
import { log } from './logger.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { decryptRouter } from './routes/decrypt.js';
import { healthRouter } from './routes/health.js';
import { startScheduler } from './scheduler/index.js';
import { startApiKeySweeper, startStateFlusher } from './store/state.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json());

app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '1y', immutable: true }));

app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const ogImageVersion = createHash('sha256').update(readFileSync(path.join(publicDir, 'og-image.png'))).digest('hex').slice(0, 10);
const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replaceAll('__PUBLIC_BASE_URL__', config.publicBaseUrl)
  .replaceAll('__OG_IMAGE_VERSION__', ogImageVersion);
app.get('/', (_req, res) => res.type('html').send(indexHtml));
app.get('/favicon.svg', (_req, res) =>
  res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(publicDir, 'favicon.svg')),
);
app.get('/og-image.png', (_req, res) =>
  res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(publicDir, 'og-image.png')),
);
app.get('/manifest.webmanifest', (_req, res) =>
  res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(publicDir, 'manifest.webmanifest')),
);

app.use(healthRouter);
app.use(decryptRouter);
app.use(authRouter);
app.use(dashboardRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

startJobSweeper();
startStateFlusher();
startApiKeySweeper();
startScheduler();

app.listen(config.port, config.bindHost, () => {
  log.info(`dkrypt listening on ${config.bindHost}:${config.port}`);
});
