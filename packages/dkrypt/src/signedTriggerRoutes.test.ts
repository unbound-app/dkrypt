import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { signedTriggerRoutes } from '#routes/signedTriggerRoutes.js';
import { createSignedTriggerPolicy, getIntegrationDelivery } from '#store/integrationRepository.js';

test('signed trigger checks the exact request body before any decrypt side effect', async () => {
  const policy = createSignedTriggerPolicy({ projectId: 'default', bundleIds: ['com.example.allowed'], sources: ['appstore'], createdBy: 'root' });
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(signedTriggerRoutes);
  const eventId = randomUUID();
  const timestamp = String(Date.now());
  const body = '{"bundleId":"com.example.denied","source":"appstore"}';
  const signature = createHmac('sha256', policy.secret).update(`${timestamp}.${eventId}.${body}`).digest('hex');
  const url = `/v1/integrations/decrypt-trigger/${policy.id}`;
  try {
    const invalid = await server.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-dkrypt-timestamp': timestamp, 'x-dkrypt-event-id': eventId, 'x-dkrypt-signature': signature }, payload: body.replace('denied', 'changed') });
    expect(invalid.statusCode).toBe(401);
    const scoped = await server.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-dkrypt-timestamp': timestamp, 'x-dkrypt-event-id': eventId, 'x-dkrypt-signature': signature }, payload: body });
    expect(scoped.statusCode).toBe(403);
    expect(getIntegrationDelivery(policy.id, eventId)).toBeUndefined();
  } finally {
    await server.close();
  }
});
