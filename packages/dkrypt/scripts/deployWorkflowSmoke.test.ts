import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

function deploymentSmokeScripts(): string[] {
  const workflow = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  return [...workflow.matchAll(/^[ ]+docker exec -i[^\n]*bun - <<'JS'\r?\n([\s\S]*?)^[ ]+JS$/gm)]
    .map((match) => {
      const indentation = match[0].match(/^[ ]+/)?.[0] ?? '';
      return match[1].split(/\r?\n/).map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n');
    });
}

test('deployment smoke scripts are valid JavaScript before they reach the homelab', () => {
  const scripts = deploymentSmokeScripts();
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(script)).not.toThrow();
});

test('deployment smoke syntax validation detects duplicate declarations', () => {
  const invalidScript = 'const status = 1;\nconst status = 2;';
  expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(invalidScript)).toThrow('already been declared');
});

test('deployment smoke verifies API-key artifact access and the configured root login gate', () => {
  const [script] = deploymentSmokeScripts();
  expect(script).toContain("`${base}/v1/artifacts?limit=1`");
  expect(script).toContain("loginError.code !== 'mfa_required'");
  expect(script).toContain('rootMfaChallenge = true;');
  expect(script).toContain('apiKeyArtifactListing: true');
  expect(script).not.toContain('authenticated dashboard probes skipped because root MFA is enabled');
});
