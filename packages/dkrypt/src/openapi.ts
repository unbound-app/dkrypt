export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'dkrypt API', version: '1.0.0', description: 'Queue decrypt jobs and retrieve completed files.' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Job: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, bundleId: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] }, progress: { type: 'string' }, source: { type: 'string', enum: ['manual', 'scheduler'] } } },
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/v1/decrypt': { get: { summary: 'Decrypt an App Store app', parameters: [{ name: 'bundleId', in: 'query', required: true, schema: { type: 'string' }, example: 'com.hammerandchisel.discord' }, { name: 'externalVersionId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Completed IPA file' }, '202': { description: 'Queued job', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } }, '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, '401': { description: 'Invalid API key' } } } },
    '/v1/jobs/{id}': { get: { summary: 'Get job status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Job status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } }, '404': { description: 'Job not found' } } } },
    '/v1/jobs/{id}/file': { get: { summary: 'Download a completed job', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Completed IPA file' }, '409': { description: 'Job is not complete', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } } } } },
  },
} as const;
