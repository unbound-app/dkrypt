import { config } from '#config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describeHttpError } from '#util/httpError.js';
import { normalizeVersion } from '#util/version.js';

const GITHUB_API = 'https://api.github.com';
const RATE_LIMIT_CACHE_MS = 30_000;

export interface GitHubRateLimitBudget {
  limit: number;
  remaining: number;
  resetAt: number;
}

let cachedRateLimit: { value: GitHubRateLimitBudget; at: number } | undefined;
const requestTelemetry = new AsyncLocalStorage<{ requests: number }>();

export async function measureGitHubRequests<T>(fn: () => Promise<T>): Promise<{ value: T; requests: number }> {
  const telemetry = { requests: 0 };
  const value = await requestTelemetry.run(telemetry, fn);
  return { value, requests: telemetry.requests };
}

async function githubFetch(input: string, init: RequestInit): Promise<Response> {
  const telemetry = requestTelemetry.getStore();
  if (telemetry) telemetry.requests += 1;
  return fetch(input, init);
}

function headers(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.ghToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function getGitHubRateLimitBudget(force = false): Promise<GitHubRateLimitBudget | undefined> {
  if (!config.ghToken) return undefined;
  if (!force && cachedRateLimit && Date.now() - cachedRateLimit.at < RATE_LIMIT_CACHE_MS) return cachedRateLimit.value;
  const response = await githubFetch(`${GITHUB_API}/rate_limit`, { headers: headers() });
  if (!response.ok) throw new Error(describeHttpError('GitHub rate-limit lookup failed', response));
  const body = (await response.json()) as { resources?: { core?: { limit?: number; remaining?: number; reset?: number } } };
  const core = body.resources?.core;
  if (typeof core?.limit !== 'number' || typeof core.remaining !== 'number' || typeof core.reset !== 'number') return undefined;
  const value = { limit: core.limit, remaining: core.remaining, resetAt: core.reset * 1000 };
  cachedRateLimit = { value, at: Date.now() };
  return value;
}

interface Release {
  tag_name: string;
  created_at: string;
}

interface GitHubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  archived: boolean;
  disabled: boolean;
}

interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

interface GitHubWorkflowsResponse {
  workflows: GitHubWorkflow[];
}

async function listReleases(repo: string): Promise<Release[]> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, { headers: headers() });
  if (!res.ok) throw new Error(describeHttpError(`list releases failed for ${repo}`, res));
  return (await res.json()) as Release[];
}

export interface DispatchRepoOption {
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export interface WorkflowOption {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface DispatchValidationTarget {
  repo: string;
  ghWorkflowFile: string;
  mode: 'repository_dispatch' | 'workflow_dispatch';
  ref?: string;
  inputs?: Record<string, string>;
}

export interface DispatchValidationResult {
  repo: string;
  workflow: string;
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

export async function validateDispatchTarget(target: DispatchValidationTarget): Promise<DispatchValidationResult> {
  const checks: DispatchValidationResult['checks'] = [];
  try {
    const repoResponse = await githubFetch(`${GITHUB_API}/repos/${target.repo}`, { headers: headers() });
    if (!repoResponse.ok) throw new Error(describeHttpError('repository lookup failed', repoResponse));
    const repo = (await repoResponse.json()) as GitHubRepo & { permissions?: { push?: boolean; admin?: boolean } };
    checks.push({ label: 'Repository access', ok: true, detail: `${repo.default_branch} is accessible` });
    checks.push({ label: 'Dispatch permission', ok: repo.permissions?.push === true || repo.permissions?.admin === true, detail: repo.permissions?.push || repo.permissions?.admin ? 'token can push to the repository' : 'token does not report push permission' });
    const workflows = await listRepoWorkflows(target.repo);
    const workflow = workflows.find((candidate) => candidate.path === target.ghWorkflowFile || candidate.path.endsWith(`/${target.ghWorkflowFile}`));
    checks.push({ label: 'Workflow', ok: !!workflow && workflow.state === 'active', detail: workflow ? `${workflow.name} is ${workflow.state}` : 'workflow was not found' });
    if (target.mode === 'workflow_dispatch' && target.ref) {
      const refResponse = await githubFetch(`${GITHUB_API}/repos/${target.repo}/git/ref/heads/${encodeURIComponent(target.ref)}`, { headers: headers() });
      checks.push({ label: 'Workflow ref', ok: refResponse.ok, detail: refResponse.ok ? `${target.ref} exists` : `${target.ref} could not be resolved` });
    }
    const inputEntries = Object.entries(target.inputs ?? {});
    checks.push({ label: 'Workflow inputs', ok: inputEntries.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) && value.length <= 500), detail: `${inputEntries.length} custom inputs are well formed` });
  } catch (err) {
    checks.push({ label: 'GitHub validation', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  return { repo: target.repo, workflow: target.ghWorkflowFile, ok: checks.every((check) => check.ok), checks };
}

export async function listDispatchRepos(): Promise<DispatchRepoOption[]> {
  const repos: DispatchRepoOption[] = [];
  let page = 1;

  while (page <= 3) {
    const res = await githubFetch(`${GITHUB_API}/user/repos?sort=updated&direction=desc&per_page=100&page=${page}`, { headers: headers() });
    if (!res.ok) throw new Error(describeHttpError('list repos failed', res));

    const batch = (await res.json()) as GitHubRepo[];
    const active = batch.filter((repo) => !repo.archived && !repo.disabled);
    repos.push(
      ...active.map((repo) => ({
        fullName: repo.full_name,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
      })),
    );

    if (batch.length < 100) break;
    page += 1;
  }

  return repos;
}

export async function listRepoWorkflows(repo: string): Promise<WorkflowOption[]> {
  const workflows: WorkflowOption[] = [];
  let page = 1;

  while (page <= 3) {
    const res = await githubFetch(`${GITHUB_API}/repos/${repo}/actions/workflows?per_page=100&page=${page}`, { headers: headers() });
    if (!res.ok) throw new Error(describeHttpError(`list workflows failed for ${repo}`, res));

    const body = (await res.json()) as GitHubWorkflowsResponse;
    workflows.push(...body.workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
    })));

    if (body.workflows.length < 100) break;
    page += 1;
  }

  return workflows;
}

export async function listReleaseVersions(repo: string): Promise<Set<string>> {
  const releases = await listReleases(repo);
  return new Set(releases.map((r) => normalizeVersion(r.tag_name)).filter((v) => !v.includes('_')));
}

export async function listReleaseTagNames(repo: string): Promise<Set<string>> {
  const releases = await listReleases(repo);
  return new Set(releases.map((r) => r.tag_name));
}

export async function dispatchIpaUpdate(
  dispatchRepo: string,
  workflowFile: string,
  ipaUrl: string,
  isTestflight: boolean,
  mode: 'repository_dispatch' | 'workflow_dispatch' = 'repository_dispatch',
  ref?: string,
  inputs?: Record<string, string>,
): Promise<void> {
  if (mode === 'workflow_dispatch') {
    const selectedRef = ref || (await getDefaultBranch(dispatchRepo));
    const res = await githubFetch(`${GITHUB_API}/repos/${dispatchRepo}/actions/workflows/${workflowFile}/dispatches`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: selectedRef, inputs: { ...inputs, ipa_url: ipaUrl, is_testflight: String(isTestflight) } }),
    });
    if (res.status !== 204) throw new Error(`workflow_dispatch failed: HTTP ${res.status} ${await res.text()}`);
    return;
  }
  const res = await githubFetch(`${GITHUB_API}/repos/${dispatchRepo}/dispatches`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'ipa-update',
      client_payload: { ipa_url: ipaUrl, is_testflight: isTestflight, inputs },
    }),
  });

  if (res.status !== 204) {
    throw new Error(`repository_dispatch failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function getDefaultBranch(repo: string): Promise<string> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}`, { headers: headers() });
  if (!res.ok) throw new Error(describeHttpError('get repository failed', res));
  const body = (await res.json()) as GitHubRepo;
  if (!body.default_branch) throw new Error('repository has no default branch');
  return body.default_branch;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

export async function findDispatchedRun(
  dispatchRepo: string,
  workflowFile: string,
  since: Date,
  event: 'repository_dispatch' | 'workflow_dispatch' = 'repository_dispatch',
): Promise<WorkflowRun | undefined> {
  const url = `${GITHUB_API}/repos/${dispatchRepo}/actions/workflows/${workflowFile}/runs?event=${event}&per_page=10`;
  const res = await githubFetch(url, { headers: headers() });
  if (!res.ok) throw new Error(describeHttpError('list workflow runs failed', res));

  const body = (await res.json()) as WorkflowRunsResponse;
  const candidates = body.workflow_runs
    .filter((r) => new Date(r.created_at) >= since)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return candidates[0];
}

export async function getRun(dispatchRepo: string, runId: number): Promise<WorkflowRun> {
  const res = await githubFetch(`${GITHUB_API}/repos/${dispatchRepo}/actions/runs/${runId}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(describeHttpError('get run failed', res));
  return (await res.json()) as WorkflowRun;
}
