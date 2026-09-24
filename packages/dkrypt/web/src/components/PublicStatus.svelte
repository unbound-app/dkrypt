<script lang="ts">
  import { CheckCircle2, CircleAlert, CircleHelp, Clock3, RefreshCw, Wrench } from 'lucide-svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import PublicPageFooter from '#components/PublicPageFooter.svelte';
  import PublicPageHeader from '#components/PublicPageHeader.svelte';

  type ComponentState = 'operational' | 'degraded' | 'maintenance' | 'not_configured' | 'paused' | 'unknown';
  type PublicStatus = {
    status: 'operational' | 'degraded' | 'maintenance';
    checkedAt: string;
    components: {
      service: { state: ComponentState };
      automation: { state: ComponentState };
      scheduler: { state: ComponentState };
    };
  };

  let status = $state<PublicStatus | null>(null);
  let loading = $state(true);
  let error = $state(false);

  const labels: Record<ComponentState, string> = {
    operational: 'Operational',
    degraded: 'Degraded',
    maintenance: 'Maintenance',
    not_configured: 'Not configured',
    paused: 'Paused',
    unknown: 'Checking',
  };

  function stateVariant(state: ComponentState): 'success' | 'warning' | 'destructive' | 'secondary' {
    if (state === 'operational') return 'success';
    if (state === 'degraded' || state === 'paused' || state === 'not_configured') return 'warning';
    if (state === 'maintenance') return 'destructive';
    return 'secondary';
  }

  function stateIcon(state: ComponentState) {
    if (state === 'operational') return CheckCircle2;
    if (state === 'maintenance') return Wrench;
    if (state === 'degraded' || state === 'paused') return CircleAlert;
    return CircleHelp;
  }

  function formatCheckedAt(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = false;
    try {
      const response = await fetch('/v1/status', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('status request failed');
      status = (await response.json()) as PublicStatus;
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(interval);
  });

  const statusLabel = $derived(status?.status === 'operational' ? 'All systems operational' : status?.status === 'maintenance' ? 'Maintenance in progress' : 'Some systems are degraded');
</script>

<div class="min-h-screen">
  <PublicPageHeader />
  <main class="mx-auto max-w-4xl px-5 py-12">
    <div class="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Live service health</div>
        <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">dkrypt status</h1>
        <p class="mt-3 max-w-2xl text-sm leading-6 text-muted">A concise view of dkrypt availability and device automation. Individual account and device details stay private.</p>
      </div>
      <Button variant="outline" size="sm" loading={loading} onclick={() => void refresh()} aria-label="Refresh service status">
        <RefreshCw class="size-3.5" />
        Refresh
      </Button>
    </div>

    {#if error}
      <Card class="border-warn/40">
        <div class="flex items-start gap-3">
          <CircleAlert class="mt-0.5 size-5 shrink-0 text-warn" />
          <div>
            <h2 class="font-semibold">Status is temporarily unavailable</h2>
            <p class="mt-1 text-sm text-muted">The status service could not be reached. Try again in a moment.</p>
          </div>
        </div>
      </Card>
    {:else if loading && !status}
      <Card>
        <div class="flex items-center gap-3 text-sm text-muted"><RefreshCw class="size-4 animate-spin" /> Checking current status…</div>
      </Card>
    {:else if status}
      <Card class="mb-5">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="size-2.5 rounded-full {status.status === 'operational' ? 'bg-ok' : status.status === 'maintenance' ? 'bg-destructive' : 'bg-warn'}" aria-hidden="true"></span>
              <h2 class="text-lg font-semibold">{statusLabel}</h2>
            </div>
            <div class="mt-2 flex items-center gap-2 text-xs text-muted"><Clock3 class="size-3.5" /> Checked {formatCheckedAt(status.checkedAt)}</div>
          </div>
          <Badge variant={stateVariant(status.status)}>{labels[status.status]}</Badge>
        </div>
      </Card>

      <div class="grid gap-4 sm:grid-cols-3">
        {#each [
          ['service', 'Service', status.components.service.state],
          ['automation', 'Device automation', status.components.automation.state],
          ['scheduler', 'Scheduler', status.components.scheduler.state],
        ] as component (component[0])}
          {@const Icon = stateIcon(component[2] as ComponentState)}
          <Card>
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-sm font-semibold">{component[1]}</div>
                <div class="mt-2 text-sm text-muted">{labels[component[2] as ComponentState]}</div>
              </div>
              <Icon class="size-5 {component[2] === 'operational' ? 'text-ok' : component[2] === 'maintenance' ? 'text-destructive' : 'text-warn'}" aria-hidden="true" />
            </div>
          </Card>
        {/each}
      </div>
    {/if}
  </main>
  <PublicPageFooter />
</div>
