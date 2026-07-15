<script lang="ts">
  import Card from '../lib/components/ui/Card.svelte';
  import { sessionState } from '../lib/session.svelte';

  const base = $derived(sessionState.publicBaseUrl ?? location.origin);
</script>

<div class="flex flex-col gap-4">
  <Card title="Using an API key">
    <div class="mb-2.5 text-sm text-muted">
      Every request needs <code>Authorization: Bearer &lt;key&gt;</code> - get a key from the API Keys tab first.
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/decrypt?bundleId=com.hammerandchisel.discord" \
  -o discord.ipa</pre>
  </Card>

  <Card title="Check job status">
    <div class="mb-2.5 text-sm text-muted">
      If a decrypt is still running when the request above times out, it responds with a job id instead of the file.
    </div>
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/jobs/&lt;JOB_ID&gt;"</pre>
  </Card>

  <Card title="Download once ready">
    <pre class="border-border overflow-x-auto rounded-md border bg-panel-muted p-3 text-[12.5px] leading-relaxed">curl -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \
  "{base}/v1/jobs/&lt;JOB_ID&gt;/file" \
  -o discord.ipa</pre>
  </Card>
</div>
