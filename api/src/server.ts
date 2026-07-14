import express from 'express';
import { config } from './config.js';
import { startJobSweeper } from './jobs/store.js';
import { log } from './logger.js';
import { decryptRouter } from './routes/decrypt.js';
import { healthRouter } from './routes/health.js';
import { startScheduler } from './scheduler/index.js';

const app = express();

// Every route requires auth (see auth.ts) - there is deliberately no
// unauthenticated path, not even health checks.
app.use(healthRouter);
app.use(decryptRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

startJobSweeper();
startScheduler();

app.listen(config.port, () => {
  log.info(`ipadecrypt-service listening on :${config.port}`);
});
