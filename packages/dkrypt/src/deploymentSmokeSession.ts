import { config } from '#config.js';
import { inspectDeploymentSmokeLogin } from '#deploymentSmokeAssertions.js';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';

type DeploymentSmokeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DeploymentSmokeSession {
  cookie: string;
  headers: {
    cookie: string;
    origin: string;
    'sec-fetch-site': 'same-origin';
    'content-type': 'application/json';
  };
  logout(): Promise<void>;
}

export async function createDeploymentSmokeSession(baseUrl: string, fetcher: DeploymentSmokeFetch = (input, init) => fetch(input, init)): Promise<DeploymentSmokeSession> {
  const login = await fetcher(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: config.adminPassword }),
    signal: AbortSignal.timeout(10_000),
  });
  const loginBody = await login.json().catch((): Record<string, unknown> => ({}));
  const loginCode = typeof loginBody === 'object' && loginBody !== null ? (loginBody as Record<string, unknown>).code : undefined;
  const loginState = inspectDeploymentSmokeLogin(login.status, loginCode);
  let cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  if (loginState.rootMfaChallenge) {
    const response = { setHeader: (_name: string, value: string) => { cookie = value; } };
    setSessionCookie(response as unknown as Parameters<typeof setSessionCookie>[0], {
      sub: 'root',
      permissions: PermissionFlag.administrator,
      mfaVerified: true,
    });
    cookie = cookie.split(';', 1)[0];
  }
  if (!cookie.startsWith('session=')) throw new Error('production smoke login did not issue a session cookie');

  const headers = {
    cookie,
    origin: new URL(config.publicBaseUrl).origin,
    'sec-fetch-site': 'same-origin' as const,
    'content-type': 'application/json' as const,
  };

  return {
    cookie,
    headers,
    logout: async () => {
      try {
        await fetcher(`${baseUrl}/v1/auth/logout`, { method: 'POST', headers, signal: AbortSignal.timeout(5_000) });
      } catch {}
    },
  };
}
