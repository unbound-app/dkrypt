import { expect, test } from 'bun:test';
import { buildServer } from '#server.js';

test('every versioned route is represented in generated OpenAPI', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, Record<string, unknown>> };
    const paths = Object.entries(document.paths ?? {}).filter(([path]) => path.startsWith('/v1/'));
    expect(paths.length).toBeGreaterThan(100);
    for (const [, methods] of paths) {
      expect(Object.keys(methods).length).toBeGreaterThan(0);
      for (const [method, operation] of Object.entries(methods)) {
        const value = operation as { responses?: Record<string, unknown>; requestBody?: { content?: Record<string, { schema?: unknown }> } };
        expect(Object.keys(value.responses ?? {}).length).toBeGreaterThan(0);
        if (method !== 'get' && method !== 'delete' && value.requestBody) {
          const schema = value.requestBody?.content?.['application/json']?.schema;
          expect(schema).toBeDefined();
        }
      }
    }
  } finally {
    await server.close();
  }
});
