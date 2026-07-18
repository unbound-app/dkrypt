<script lang="ts">
  import CopyButton from '../components/CopyButton.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import { sessionState } from '../lib/session.svelte';

  const base = $derived(sessionState.publicBaseUrl ?? location.origin);

  const usingApiKeyCmd = $derived(
    `curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  "${base}/v1/decrypt?bundleId=com.hammerandchisel.discord" \\\n  -o discord.ipa`,
  );
  const jobStatusCmd = $derived(`curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  "${base}/v1/jobs/<JOB_ID>"`);
  const downloadCmd = $derived(`curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  "${base}/v1/jobs/<JOB_ID>/file" \\\n  -o discord.ipa`);
  const specificVersionCmd = $derived(
    `curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  "${base}/v1/decrypt?bundleId=com.hammerandchisel.discord&externalVersionId=<EXTERNAL_VERSION_ID>" \\\n  -o discord.ipa`,
  );
  const tfTrainsCmd = $derived(`curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  "${base}/v1/testflight/<APP_ID>/trains"`);
  const tfBuildsCmd = $derived(`curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  "${base}/v1/testflight/<APP_ID>/builds?trainVersion=<TRAIN_VERSION>"`);
  const tfDecryptCmd = $derived(`curl -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -X POST "${base}/v1/testflight/decrypt" \\\n  -d '{
    "bundleId":"com.example.app",
    "appId":123456789,
    "build":{"id":123,"bundleId":"com.example.app","cfBundleShortVersion":"1.2.3","cfBundleVersion":"456"}
  }'`);
</script>

<div class="flex flex-col gap-4">
  <Card title="Using an API key">
    {#snippet headerExtra()}
      <CopyButton text={usingApiKeyCmd} />
    {/snippet}
    <div class="mb-2.5 text-sm text-muted">
      Every request needs <code>Authorization: Bearer &lt;key&gt;</code> - get a key from the API Keys tab first.
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/decrypt?bundleId=com.hammerandchisel.discord" \
  -o discord.ipa</pre>
  </Card>

  <Card title="Check job status">
    {#snippet headerExtra()}
      <CopyButton text={jobStatusCmd} />
    {/snippet}
    <div class="mb-2.5 text-sm text-muted">
      If a decrypt is still running when the request above times out, it responds with a job id instead of the file.
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/jobs/&lt;JOB_ID&gt;"</pre>
  </Card>

  <Card title="Download once ready">
    {#snippet headerExtra()}
      <CopyButton text={downloadCmd} />
    {/snippet}
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/jobs/&lt;JOB_ID&gt;/file" \
  -o discord.ipa</pre>
  </Card>

  <Card title="Decrypt a specific version">
    {#snippet headerExtra()}
      <CopyButton text={specificVersionCmd} />
    {/snippet}
    <div class="mb-2.5 text-sm text-muted">
      Add <code>externalVersionId</code> to pin to a historical App Store release instead of the current one - get the
      id from the clock-icon button next to a search result on the Home tab.
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/decrypt?bundleId=com.hammerandchisel.discord&externalVersionId=&lt;EXTERNAL_VERSION_ID&gt;" \
  -o discord.ipa</pre>
  </Card>

  <Card title="Decrypt a TestFlight build">
    <div class="mb-2.5 text-sm text-muted">List trains, list builds, then queue a decrypt for the chosen build payload.</div>
    <div class="mb-2.5">
      <div class="mb-1 text-xs text-muted">List trains</div>
      <CopyButton text={tfTrainsCmd} />
    </div>
    <div class="mb-2.5">
      <div class="mb-1 text-xs text-muted">List builds in a train</div>
      <CopyButton text={tfBuildsCmd} />
    </div>
    <div class="mb-2.5">
      <div class="mb-1 text-xs text-muted">Queue TestFlight decrypt</div>
      <CopyButton text={tfDecryptCmd} />
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">{`curl -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -X POST "${base}/v1/testflight/decrypt" \
  -d '{"bundleId":"com.example.app","appId":123456789,"build":{"id":123,"bundleId":"com.example.app","cfBundleShortVersion":"1.2.3","cfBundleVersion":"456"}}'`}</pre>
  </Card>

  <Card title="Notes">
    <ul class="list-disc space-y-1.5 pl-4 text-sm text-muted">
      <li>
        A key created with a bundle ID restriction (API Keys tab) gets a <code>403</code> from every endpoint above
        for any bundle ID outside that list - unrestricted keys (the default, and the root <code>API_KEY</code>)
        aren't affected.
      </li>
        <li>
          Job history browsing is dashboard/session-based. Decrypting TestFlight builds is available for both dashboard
          sessions and API keys.
        </li>
      <li>
          TestFlight builds can be accessed via the API using the commands listed above.
      </li>
    </ul>
  </Card>

  <Card title="Errors & rate limits">
    <div class="mb-2.5 text-sm text-muted">Every non-2xx response body is <code>{'{ "error": "<message>" }'}</code>.</div>
    <table class="responsive-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Meaning</th>
        </tr>
      </thead>
      <tbody>
        <tr><td data-label="Status"><code>400</code></td><td data-label="Meaning">Missing or malformed query param (e.g. <code>bundleId</code>)</td></tr>
        <tr><td data-label="Status"><code>401</code></td><td data-label="Meaning">Missing or invalid API key</td></tr>
        <tr><td data-label="Status"><code>403</code></td><td data-label="Meaning">API key isn't scoped to this <code>bundleId</code></td></tr>
        <tr><td data-label="Status"><code>404</code></td><td data-label="Meaning">Job not found - finished jobs are pruned after their retention window</td></tr>
        <tr><td data-label="Status"><code>409</code></td><td data-label="Meaning"><code>/v1/jobs/&lt;id&gt;/file</code> requested before the job reached <code>done</code> - body is the job summary below</td></tr>
        <tr><td data-label="Status"><code>429</code></td><td data-label="Meaning">API key hit its daily request limit (API Keys tab)</td></tr>
        <tr><td data-label="Status"><code>500</code></td><td data-label="Meaning">Decrypt failed - body is the job summary with an <code>error</code> field</td></tr>
      </tbody>
    </table>
    <div class="mt-3 mb-2.5 text-sm text-muted">
      <code>202</code> is a success - the decrypt is still running when <code>/v1/decrypt</code> times out. The body is a job summary; poll <code>/v1/jobs/&lt;id&gt;</code> until <code>status</code> is <code>done</code> or <code>failed</code>:
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">{`{
  "id": "3fa2...",
  "bundleId": "com.hammerandchisel.discord",
  "status": "running",
  "progress": "decrypting…",
  "source": "manual",
  "createdAt": "2026-07-17T20:00:00.000Z",
  "queue": { "position": 1, "total": 1 },
  "statusUrl": "/v1/jobs/3fa2...",
  "fileUrl": "/v1/jobs/3fa2.../file"
}`}</pre>
  </Card>

  <Card title="Live dashboard events (SSE)">
    <div class="mb-2.5 text-sm text-muted">
      <code>GET /v1/dashboard/events</code> is what the dashboard UI itself uses to stay live - it's session-authenticated
      (browser cookie), not available to API keys, and documented here only so a custom dashboard client isn't stuck
      reading source. Four event types stream over it:
    </div>
    <ul class="list-disc space-y-1.5 pl-4 text-sm text-muted">
      <li><code>overview</code> - the full dashboard overview payload, sent on connect and whenever a job changes</li>
      <li><code>log</code> - one new log line, only sent to sessions with the <code>viewLogs</code> permission</li>
      <li><code>history</code> - one new job history entry as it's recorded</li>
      <li><code>appleAuth</code> - Apple re-authentication status, only sent to sessions with <code>manageAppleAuth</code></li>
    </ul>
  </Card>
</div>
