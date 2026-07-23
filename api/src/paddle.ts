import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { config } from './config.js';

let paddle: Paddle | undefined;

export function getPaddle(): Paddle {
  if (!config.paddleApiKey) throw new Error('Paddle API key is not configured');
  paddle ??= new Paddle(config.paddleApiKey, {
    environment: config.paddleEnvironment === 'production' ? Environment.production : Environment.sandbox,
  });
  return paddle;
}
