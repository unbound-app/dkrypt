import { Environment, EventName, Paddle } from '@paddle/paddle-node-sdk';

const environment = process.env.PADDLE_ENV === 'production' ? Environment.production : Environment.sandbox;
const environmentName = environment === Environment.production ? 'production' : 'sandbox';
const apiKey =
  process.env.PADDLE_API_KEY ??
  (environment === Environment.production ? process.env.PADDLE_LIVE_API_KEY : process.env.PADDLE_SANDBOX_API_KEY);
const destination = process.env.PADDLE_WEBHOOK_URL;

if (!apiKey) throw new Error(`Paddle API key is required for ${environmentName}`);
if (!destination) throw new Error('PADDLE_WEBHOOK_URL is required');
if (!destination.startsWith('https://')) throw new Error('PADDLE_WEBHOOK_URL must use HTTPS');

const paddle = new Paddle(apiKey, { environment });
const subscribedEvents = [
  EventName.CustomerCreated,
  EventName.CustomerUpdated,
  EventName.SubscriptionCreated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
  EventName.TransactionCompleted,
];

const destinations = await paddle.notificationSettings.list({ active: true, perPage: 200 });
const existing = destinations.find((item) => item.destination === destination);
const notification = existing
  ? await paddle.notificationSettings.update(existing.id, {
      description: `dkrypt ${environmentName} billing`,
      destination,
      subscribedEvents,
      active: true,
    })
  : await paddle.notificationSettings.create({
      description: `dkrypt ${environmentName} billing`,
      destination,
      subscribedEvents,
      type: 'url',
    });

console.log(
  JSON.stringify(
    {
      environment: environmentName,
      notificationId: notification.id,
      destination: notification.destination,
      endpointSecretKey: notification.endpointSecretKey || undefined,
    },
    null,
    2,
  ),
);
