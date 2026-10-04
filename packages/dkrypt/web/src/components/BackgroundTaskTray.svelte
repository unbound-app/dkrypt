<script lang="ts">
  import { onMount } from 'svelte';
  import { ListTodo } from 'lucide-svelte';
  import { fetchDeviceSetupOperations } from '#lib/api';
  import { backgroundTasksState, clearBackgroundTasks, dismissBackgroundTask, loadBackgroundTasks, putBackgroundTask } from '#lib/backgroundTasks.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission, sessionState } from '#lib/session.svelte';

  let open = $state(false);
  let now = $state(Date.now());
  const activeCount = $derived(backgroundTasksState.items.filter((task) => task.status === 'running').length);

  $effect(() => {
    if (sessionState.loggedIn && sessionState.sub) loadBackgroundTasks(sessionState.sub);
    else clearBackgroundTasks();
  });

  async function syncDeviceSetups(): Promise<void> {
    if (!sessionHasPermission(PermissionFlag.manageDevices)) return;
    try {
      const { operations } = await fetchDeviceSetupOperations();
      for (const operation of operations.slice(0, 10).reverse()) {
        if (operation.status === 'complete' && !backgroundTasksState.items.some((task) => task.id === operation.id)) continue;
        const status = operation.status === 'queued' || operation.status === 'running' ? 'running' : operation.status === 'complete' ? 'complete' : operation.status;
        const stage = operation.status === 'complete' ? operation.ready ? 'Device ready' : 'Setup finished with attention needed' : operation.stages.at(-1)?.label ?? 'Waiting to connect';
        putBackgroundTask({ id: operation.id, kind: 'device_setup', title: 'Device setup', stage, status, href: '/?tab=settings&stab=devices', startedAt: operation.createdAt, updatedAt: operation.updatedAt, detail: operation.error });
      }
    } catch {}
  }

  onMount(() => {
    void syncDeviceSetups();
    const elapsedTimer = setInterval(() => (now = Date.now()), 1_000);
    const syncTimer = setInterval(() => void syncDeviceSetups(), 5_000);
    return () => {
      clearInterval(elapsedTimer);
      clearInterval(syncTimer);
    };
  });
</script>

{#if backgroundTasksState.items.length > 0}
  <Button variant="secondary" size="icon" aria-label={activeCount > 0 ? `Background tasks, ${activeCount} running` : 'Background tasks'} title="Background tasks" onclick={() => (open = true)}>
    <ListTodo class="h-4 w-4" />
  </Button>
{/if}

<Dialog {open} onOpenChange={(value) => (open = value)} class="max-w-lg">
  <h2 class="text-sm font-semibold">Background tasks</h2>
  <p class="mt-1 text-xs text-muted">Device setup continues after you leave its page. Browser-only tasks interrupted by a reload are labeled as such.</p>
  <div class="mt-4 max-h-[60vh] space-y-2 overflow-y-auto">
    {#each backgroundTasksState.items as task (task.id)}
      <div class="rounded-lg border border-border p-3 text-xs">
        <div class="flex items-start justify-between gap-2"><span class="font-medium">{task.title}</span><span class={task.status === 'failed' ? 'text-err' : task.status === 'complete' ? 'text-ok' : 'text-muted'}>{task.status}</span></div>
        <div class="mt-1 text-muted">{task.stage} · {Math.max(0, Math.floor(((task.status === 'running' ? now : task.updatedAt) - task.startedAt) / 1000))}s {task.status === 'running' ? 'elapsed' : 'total'}</div>
        {#if task.detail}<div class="mt-1 text-warn" data-sensitive="true">{task.detail}</div>{/if}
        <div class="mt-2 flex gap-2"><a href={task.href} class="text-accent underline" onclick={() => (open = false)}>Open {task.kind === 'device_setup' || task.kind === 'device_check' ? 'Devices' : 'Library'}</a>{#if task.status !== 'running'}<button type="button" class="text-muted underline" onclick={() => dismissBackgroundTask(task.id)}>Dismiss</button>{/if}</div>
      </div>
    {/each}
  </div>
</Dialog>
