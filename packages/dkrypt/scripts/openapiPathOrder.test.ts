import { expect, test } from 'bun:test';
import { preserveOpenApiPathOrder } from './openapiPathOrder.js';

test('preserves existing OpenAPI path order and sorts newly added paths', () => {
  const previous = {
    '/v1/zebra': { summary: 'previous zebra' },
    '/v1/alpha': { summary: 'previous alpha' },
    '/v1/removed': { summary: 'removed' },
  };
  const current = {
    '/v1/beta': { summary: 'new beta' },
    '/v1/alpha': { summary: 'updated alpha' },
    '/v1/zebra': { summary: 'updated zebra' },
  };

  const ordered = preserveOpenApiPathOrder(previous, current);

  expect(Object.keys(ordered)).toEqual(['/v1/zebra', '/v1/alpha', '/v1/beta']);
  expect(ordered).toEqual({
    '/v1/zebra': { summary: 'updated zebra' },
    '/v1/alpha': { summary: 'updated alpha' },
    '/v1/beta': { summary: 'new beta' },
  });
});
