<script lang="ts">
  import { Plus, ScrollText, UserX } from 'lucide-svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PermissionEditor from '../../components/PermissionEditor.svelte';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { addUser, type AuditLogEntry, fetchAuditLog, fetchUsers, removeUser, updateUserPermissions, type AllowedUser } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { scrollFade } from '../../lib/scrollFade';
  import { PERMISSION_KEYS, PERMISSION_META, sessionState, VIEWER_PERMISSIONS, type Permissions } from '../../lib/session.svelte';
  import { confirmDialog } from '../../lib/ui.svelte';

  const canManage = $derived(!!sessionState.permissions?.manageUsers);

  let addOpen = $state(false);
  let username = $state('');
  let newPermissions = $state<Permissions>({ ...VIEWER_PERMISSIONS });
  let users = $state<AllowedUser[] | null>(null);
  let userSearch = $state('');
  let submitting = $state(false);
  let savingPermissions = $state(false);
  let removing = $state(false);
  let auditLog = $state<AuditLogEntry[] | null>(null);

  const AUDIT_ACTION_LABEL: Record<AuditLogEntry['action'], string> = {
    'user.add': 'added',
    'user.update': 'updated',
    'user.remove': 'removed',
  };

  const filteredUsers = $derived(
    (users ?? []).filter((u) => u.username.includes(userSearch.trim().toLowerCase())),
  );

  function activePermissionLabels(p: Permissions): string[] {
    return PERMISSION_META.filter((f) => p[f.key] && !f.impliedBy?.some((k) => p[k])).map((f) => f.label);
  }

  async function load(): Promise<void> {
    users = (await fetchUsers()).users;
    auditLog = (await fetchAuditLog(50)).entries;
  }

  $effect(() => {
    void load();
  });

  function openAdd(): void {
    username = '';
    newPermissions = { ...VIEWER_PERMISSIONS };
    addOpen = true;
  }

  async function submit(): Promise<void> {
    const name = username.trim();
    if (!name) return;
    submitting = true;
    try {
      const { ok } = await addUser(name, newPermissions);
      if (ok) {
        addOpen = false;
        void load();
      }
    } finally {
      submitting = false;
    }
  }

  let manageOpen = $state(false);
  let manageUser = $state<AllowedUser | null>(null);
  let managePermissions = $state<Permissions>({ ...VIEWER_PERMISSIONS });

  function openManage(u: AllowedUser): void {
    manageUser = u;
    managePermissions = { ...u.permissions };
    manageOpen = true;
  }

  const permissionsUnchanged = $derived.by(() => {
    if (!manageUser) return true;
    return PERMISSION_KEYS.every((k) => managePermissions[k] === manageUser?.permissions[k]);
  });

  async function savePermissions(): Promise<void> {
    if (!manageUser || permissionsUnchanged) return;
    savingPermissions = true;
    try {
      const { ok } = await updateUserPermissions(manageUser.username, managePermissions);
      if (ok) {
        manageOpen = false;
        void load();
      }
    } finally {
      savingPermissions = false;
    }
  }

  async function removeManaged(): Promise<void> {
    if (!manageUser) return;
    if (!(await confirmDialog(`Remove ${manageUser.username} from the allowlist?`))) return;
    removing = true;
    try {
      const { ok } = await removeUser(manageUser.username);
      if (ok) {
        manageOpen = false;
        void load();
      }
    } finally {
      removing = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title="Allowlist">
    {#snippet headerExtra()}
      {#if canManage}
        <Button size="sm" onclick={openAdd}>
          <Plus class="h-3.5 w-3.5" />
          Add user
        </Button>
      {/if}
    {/snippet}
    {#if (users?.length ?? 0) > 5}
      <Input placeholder="Search by username…" bind:value={userSearch} class="mb-3 max-w-xs" />
    {/if}
    <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
      <table class="min-w-[480px]">
        <thead>
          <tr>
            <th>Username</th>
            <th>Permissions</th>
            <th>Added</th>
            <th>Last active</th>
            {#if canManage}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#if users === null}
            <SkeletonRows rows={3} colspan={canManage ? 5 : 4} />
          {:else}
            {#each filteredUsers as u (u.username)}
              {@const isSelf = u.username === (sessionState.sub ?? '').toLowerCase()}
              {@const labels = activePermissionLabels(u.permissions)}
              <tr>
                <td>{u.username}{#if isSelf}<span class="ml-1.5 text-xs text-muted">(you)</span>{/if}</td>
                <td>
                  <div class="flex flex-wrap gap-1">
                    {#if labels.length === 0}
                      <Badge variant="secondary">Viewer</Badge>
                    {:else}
                      {#each labels as label (label)}
                        <Badge variant="default">{label}</Badge>
                      {/each}
                    {/if}
                  </div>
                </td>
                <td class="text-muted"><RelativeTime ms={u.addedAt} /></td>
                <td class="text-muted">
                  {#if u.lastActiveAt}
                    <RelativeTime ms={u.lastActiveAt} />
                  {:else}
                    never
                  {/if}
                </td>
                {#if canManage}
                  <td>
                    {#if !isSelf}
                      <Button size="sm" variant="secondary" onclick={() => openManage(u)}>Manage</Button>
                    {/if}
                  </td>
                {/if}
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if users !== null && users.length === 0}
      <EmptyState icon={UserX} message="No allowed users yet." />
    {:else if users !== null && filteredUsers.length === 0}
      <EmptyState icon={UserX} message={`No users match "${userSearch}".`} />
    {/if}
  </Card>

  <Card title="Audit log">
    <div class="scroll-fade-x max-h-80 overflow-auto" use:scrollFade>
      <table class="min-w-[480px]">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {#if auditLog === null}
            <SkeletonRows rows={3} colspan={5} />
          {:else}
            {#each auditLog as entry (entry.id)}
              <tr>
                <td class="text-muted"><RelativeTime ms={entry.ts} /></td>
                <td>{entry.actor}</td>
                <td><Badge variant="secondary">{AUDIT_ACTION_LABEL[entry.action]}</Badge></td>
                <td>{entry.target}</td>
                <td class="max-w-64 truncate font-mono text-xs text-muted" title={entry.detail ?? ''}>{entry.detail ?? ''}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if auditLog !== null && auditLog.length === 0}
      <EmptyState icon={ScrollText} message="No changes recorded yet." />
    {/if}
  </Card>
</div>

{#if canManage}
  <Dialog open={addOpen} onOpenChange={(v) => (addOpen = v)} class="max-w-md">
    <div class="mb-3 text-sm font-medium">Add an allowed GitHub user</div>
    <label for="user-username" class="mb-1 block text-xs text-muted">GitHub username</label>
    <Input id="user-username" placeholder="e.g. octocat" bind:value={username} />
    <div class="mt-3 max-h-[46vh] overflow-y-auto pr-0.5">
      <PermissionEditor bind:value={newPermissions} />
    </div>
    <Button class="mt-3.5 w-full" loading={submitting} onclick={submit} disabled={!username.trim()}>Add</Button>
  </Dialog>

  <Dialog open={manageOpen} onOpenChange={(v) => (manageOpen = v)} class="max-w-md">
    {#if manageUser}
      <div class="mb-3 text-sm font-medium">Manage {manageUser.username}</div>
      <div class="max-h-[50vh] overflow-y-auto pr-0.5">
        <PermissionEditor bind:value={managePermissions} />
      </div>
      <Button class="mt-3.5 w-full" loading={savingPermissions} onclick={savePermissions} disabled={permissionsUnchanged}>
        Save permissions
      </Button>
      <div class="border-border mt-4 border-t pt-4">
        <Button variant="destructive" class="w-full" loading={removing} onclick={removeManaged}>Remove from allowlist</Button>
      </div>
    {/if}
  </Dialog>
{/if}
