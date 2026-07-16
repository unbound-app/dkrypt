import { config } from '../config.js';
import { normalizeVersion } from '../util/version.js';

const GITHUB_API = 'https://api.github.com';

function headers(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.ghToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

interface Release {
  tag_name: string;
  created_at: string;
}

async function listReleases(repo: string): Promise<Release[]> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, { headers: headers() });
  if (!res.ok) throw new Error(`list releases failed for ${repo}: HTTP ${res.status}`);
  return (await res.json()) as Release[];
}

export async function listReleaseVersions(repo: string): Promise<Set<string>> {
  const releases = await listReleases(repo);
  return new Set(releases.map((r) => normalizeVersion(r.tag_name)));
}

export async function listReleaseTagNames(repo: string): Promise<Set<string>> {
  const releases = await listReleases(repo);
  return new Set(releases.map((r) => r.tag_name));
}

export async function dispatchIpaUpdate(dispatchRepo: string, ipaUrl: string, isTestflight: boolean): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${dispatchRepo}/dispatches`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'ipa-update',
      client_payload: { ipa_url: ipaUrl, is_testflight: isTestflight },
    }),
  });

  if (res.status !== 204) {
    throw new Error(`repository_dispatch failed: HTTP ${res.status} ${await res.text()}`);
  }
}

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

export async function findDispatchedRun(
  dispatchRepo: string,
  workflowFile: string,
  since: Date,
): Promise<WorkflowRun | undefined> {
  const url = `${GITHUB_API}/repos/${dispatchRepo}/actions/workflows/${workflowFile}/runs?event=repository_dispatch&per_page=10`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`list workflow runs failed: HTTP ${res.status}`);

  const body = (await res.json()) as WorkflowRunsResponse;
  const candidates = body.workflow_runs
    .filter((r) => new Date(r.created_at) >= since)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return candidates[0];
}

export async function getRun(dispatchRepo: string, runId: number): Promise<WorkflowRun> {
  const res = await fetch(`${GITHUB_API}/repos/${dispatchRepo}/actions/runs/${runId}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`get run failed: HTTP ${res.status}`);
  return (await res.json()) as WorkflowRun;
}
