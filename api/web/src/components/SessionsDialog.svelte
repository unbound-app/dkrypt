<script lang="ts">
  import { LogOut, Monitor } from 'lucide-svelte';
  import { fetchSessions, revokeOtherSessions, revokeSession, type ActiveSessionInfo } from '../lib/api';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import { fmtRelative, fmtTime } from '../lib/format';

  let { open = $bindable(), onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void } = $props();

  let sessions = $state<ActiveSessionInfo[] | null>(null);
  let revoking = $state<Set<string>>(new Set());
  let revokingOthers = $state(false);

  $effect(() => {
    if (open) void load();
  });

  async function load(): Promise<void> {
    sessions = await fetchSessions();
  }

  function describeUserAgent(ua?: string): string {
    if (!ua) return 'Unknown device';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown browser';
    return `${browser} on ${os}`;
  }

  async function revoke(id: string): Promise<void> {
    revoking = new Set(revoking).add(id);
    try {
      const { ok } = await revokeSession(id);
      if (ok) sessions = (sessions ?? []).filter((s) => s.id !== id);
    } finally {
      revoking = new Set([...revoking].filter((i) => i !== id));
    }
  }

  async function revokeAllOthers(): Promise<void> {
    revokingOthers = true;
    try {
      const { ok } = await revokeOtherSessions();
      if (ok) sessions = (sessions ?? []).filter((s) => s.current);
    } finally {
      revokingOthers = false;
    }
  }

  const otherCount = $derived((sessions ?? []).filter((s) => !s.current).length);
</script>

<Dialog {open} {onOpenChange} class="max-w-md">
  <div class="mb-1 text-sm font-medium">Active sessions</div>
  <div class="mb-3 text-xs text-muted">Devices and browsers currently signed in as you.</div>

  {#if sessions === null}
    <div class="py-4 text-center text-sm text-muted">Loading...</div>
  {:else if sessions.length === 0}
    <div class="py-4 text-center text-sm text-muted">No active sessions.</div>
  {:else}
    {#if otherCount > 0}
      <Button size="sm" variant="destructive" class="mb-3 w-full" loading={revokingOthers} onclick={revokeAllOthers}>
        Sign out {otherCount} other session{otherCount === 1 ? '' : 's'}
      </Button>
    {/if}
    <div class="flex flex-col gap-1.5">
      {#each sessions as s (s.id)}
        <div class="border-border flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
          <Monitor class="h-4 w-4 shrink-0 text-muted" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-text">{describeUserAgent(s.userAgent)}</span>
              {#if s.current}
                <Badge variant="success">This device</Badge>
              {/if}
            </div>
            <div class="text-muted" title={fmtTime(s.createdAt)}>
              {s.ip ?? 'unknown IP'} · active {fmtRelative(s.lastSeenAt)}
            </div>
          </div>
          {#if !s.current}
            <Button size="sm" variant="secondary" loading={revoking.has(s.id)} onclick={() => revoke(s.id)} aria-label="Sign out this session">
              <LogOut class="h-3.5 w-3.5" />
            </Button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Dialog>
