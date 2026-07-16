<script lang="ts">
  import type { Permissions } from '../lib/session.svelte';
  import { cn } from '../lib/utils';

  interface Props {
    value: Permissions;
  }

  let { value = $bindable() }: Props = $props();

  const FIELDS: { key: keyof Permissions; label: string; description: string }[] = [
    { key: 'decrypt', label: 'Decrypt apps', description: 'Queue decrypts and request their own API keys' },
    { key: 'manageKeys', label: 'Manage API keys', description: "Approve or deny requests, revoke anyone's key" },
    { key: 'manageSettings', label: 'Manage settings', description: 'Scheduler, dispatch, and Apple ID re-authentication' },
    { key: 'manageUsers', label: 'Manage users', description: 'Add or remove people, change their permissions' },
  ];

  const PRESETS: { label: string; permissions: Permissions }[] = [
    { label: 'Viewer', permissions: { decrypt: false, manageKeys: false, manageSettings: false, manageUsers: false } },
    { label: 'Contributor', permissions: { decrypt: true, manageKeys: false, manageSettings: false, manageUsers: false } },
    { label: 'Manager', permissions: { decrypt: true, manageKeys: true, manageSettings: false, manageUsers: false } },
    { label: 'Admin', permissions: { decrypt: true, manageKeys: true, manageSettings: true, manageUsers: true } },
  ];

  function applyPreset(p: Permissions): void {
    value = { ...p };
  }

  function matchesPreset(p: Permissions): boolean {
    return FIELDS.every((f) => value[f.key] === p[f.key]);
  }

  function toggle(key: keyof Permissions): void {
    value = { ...value, [key]: !value[key] };
  }
</script>

<div class="flex flex-wrap gap-1.5">
  {#each PRESETS as preset (preset.label)}
    <button
      type="button"
      class={cn(
        'cursor-pointer rounded-full border px-2.5 py-1 text-xs',
        matchesPreset(preset.permissions) ? 'border-accent bg-accent/15 text-text' : 'border-border text-muted hover:text-text',
      )}
      onclick={() => applyPreset(preset.permissions)}
    >
      {preset.label}
    </button>
  {/each}
</div>
<div class="mt-3 flex flex-col gap-2">
  {#each FIELDS as f (f.key)}
    <label class="border-border hover:bg-panel-muted flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5">
      <input type="checkbox" class="mt-0.5 cursor-pointer" checked={value[f.key]} onchange={() => toggle(f.key)} />
      <div class="min-w-0">
        <div class="text-sm">{f.label}</div>
        <div class="text-xs text-muted">{f.description}</div>
      </div>
    </label>
  {/each}
</div>
