import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { notify, sendTestNotification } from './notify.js';
import { updateSettings } from './store/state.js';

const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;

beforeEach(() => {
  // The retry path sleeps for real between attempts - fire immediately so retry tests stay fast.
  global.setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  global.fetch = originalFetch;
  global.setTimeout = originalSetTimeout;
  updateSettings({
    notifyWebhookUrl: '',
    notifyFormat: 'embed',
    notifyOnKeyRequest: true,
    notifyOnDispatchSuccess: true,
    notifyOnDispatchFailure: true,
    notifyOnAppleAuthAlert: true,
  });
});

describe('notify', () => {
  test('does nothing without a configured webhook URL', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('keyRequest', 'hello', { title: 'x', color: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('skips a disabled event even with a webhook configured', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook', notifyOnKeyRequest: false });
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('keyRequest', 'hello', { title: 'x', color: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('posts a Discord-shaped embed payload for an enabled event', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook', notifyOnDispatchSuccess: true });
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = mock((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('dispatchSuccess', '✅ done', {
      title: 'Decrypted & dispatched',
      color: 0x3ecf8e,
      fields: [{ name: 'App', value: 'com.example.app', inline: true }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody?.content).toBe('✅ done');
    const embeds = capturedBody?.embeds as Record<string, unknown>[];
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toBe('Decrypted & dispatched');
    expect(embeds[0].color).toBe(0x3ecf8e);
    expect((embeds[0].fields as unknown[])?.length).toBe(1);
  });

  test('truncates an oversized field value to the Discord limit', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook' });
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = mock((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('appleAuthAlert', 'x', {
      title: 'x',
      color: 0,
      fields: [{ name: 'Error', value: 'a'.repeat(2000) }],
    });

    const embeds = capturedBody?.embeds as Record<string, unknown>[];
    const value = (embeds[0].fields as Record<string, unknown>[])[0].value as string;
    expect(value.length).toBe(1024);
  });

  test('sends a flat content+text payload with no embeds when notifyFormat is plain', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook', notifyFormat: 'plain' });
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = mock((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('dispatchSuccess', '✅ done', {
      title: 'Decrypted & dispatched',
      description: 'all good',
      color: 0x3ecf8e,
      fields: [{ name: 'App', value: 'com.example.app' }],
    });

    expect(capturedBody?.embeds).toBeUndefined();
    expect(capturedBody?.content).toBe(capturedBody?.text);
    const text = capturedBody?.content as string;
    expect(text).toContain('Decrypted & dispatched');
    expect(text).toContain('all good');
    expect(text).toContain('App: com.example.app');
  });

  test('retries once after a failed attempt and succeeds', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook' });
    let calls = 0;
    const fetchMock = mock(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response('server error', { status: 500 }));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('dispatchSuccess', 'x', { title: 'x', color: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('gives up after the retry also fails', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook' });
    const fetchMock = mock(() => Promise.resolve(new Response('nope', { status: 500 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('dispatchSuccess', 'x', { title: 'x', color: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('respects a Discord 429 retry_after before retrying', async () => {
    updateSettings({ notifyWebhookUrl: 'https://example.test/webhook' });
    let calls = 0;
    const fetchMock = mock(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await notify('dispatchSuccess', 'x', { title: 'x', color: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('sendTestNotification', () => {
  test('fails without any URL', async () => {
    const result = await sendTestNotification();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no webhook URL/);
  });

  test('ignores event toggles and always posts when a URL is given', async () => {
    updateSettings({ notifyOnKeyRequest: false, notifyOnDispatchSuccess: false, notifyOnDispatchFailure: false, notifyOnAppleAuthAlert: false });
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendTestNotification('https://example.test/webhook');
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
