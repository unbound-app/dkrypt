import express from 'express';
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
import { startStateFlusher } from './store/state.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
// Caddy is the only thing that can reach the app directly (see
// docker-compose.yml), so its X-Forwarded-For can be trusted for req.ip.
app.set('trust proxy', 'loopback');
app.use(express.json());

// Every route requires auth (see auth.ts / session.ts) - the deliberate
// exceptions are the static dashboard shell itself (a login form with no
// data in it), and the login/OAuth routes needed to establish a session.
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(publicDir, 'favicon.svg')));

app.use(healthRouter);
app.use(decryptRouter);
app.use(authRouter);
app.use(dashboardRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

startJobSweeper();
startStateFlusher();
startScheduler();

app.listen(config.port, config.bindHost, () => {
  log.info(`ipadecrypt-service listening on ${config.bindHost}:${config.port}`);
});
