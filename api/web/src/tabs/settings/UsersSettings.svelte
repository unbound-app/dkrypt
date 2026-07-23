<script lang="ts">
  import { Plus, ScrollText, UserX } from 'lucide-svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import {
    addUser,
    type AuditLogEntry,
    fetchAuditLog,
    fetchRoles,
    fetchUsers,
    removeUser,
    updateUserRoles,
    type AllowedUser,
    type Role,
  } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { PermissionFlag } from '../../lib/permissions';
  import { scrollFade } from '../../lib/scrollFade';
  import { sessionHasPermission, sessionState } from '../../lib/session.svelte';
  import { confirmDialog } from '../../lib/ui.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageUsers));

  let addOpen = $state(false);
  let username = $state('');
  let newRoleIds = $state<string[]>([]);
  let users = $state<AllowedUser[] | null>(null);
  let roles = $state<Role[] | null>(null);
  let userSearch = $state('');
  let submitting = $state(false);
  let savingRoles = $state(false);
  let removing = $state(false);
  let auditLog = $state<AuditLogEntry[] | null>(null);
  let auditSearch = $state('');

  const AUDIT_ACTION_LABEL: Record<AuditLogEntry['action'], string> = {
    'user.add': 'added user',
    'user.update': 'updated user',
    'user.remove': 'removed user',
    'state.import': 'restored backup',
    'settings.update': 'updated scheduler settings',
    'watch.add': 'added watch',
    'watch.update': 'updated watch',
    'watch.remove': 'removed watch',
    'device.add': 'added device',
    'device.update': 'updated device',
    'device.remove': 'removed device',
    'role.add': 'added role',
    'role.update': 'updated role',
    'role.remove': 'removed role',
  };

  const assignableRoles = $derived((roles ?? []).filter((r) => !r.isDefault).sort((a, b) => b.position - a.position));

  function roleById(id: string): Role | undefined {
    return (roles ?? []).find((r) => r.id === id);
  }

  const filteredUsers = $derived(
    (users ?? []).filter((u) => u.username.includes(userSearch.trim().toLowerCase())),
  );

  let selectedUsers = $state<Set<string>>(new Set());
  let bulkApplying = $state(false);

  const selectableUsers = $derived(filteredUsers.filter((u) => u.username !== (sessionState.sub ?? '').toLowerCase()));

  function toggleSelectUser(username: string): void {
    const next = new Set(selectedUsers);
    if (next.has(username)) next.delete(username);
    else next.add(username);
    selectedUsers = next;
  }

  function toggleSelectAllUsers(): void {
    selectedUsers = selectedUsers.size === selectableUsers.length ? new Set() : new Set(selectableUsers.map((u) => u.username));
  }

  async function applyRoleToSelected(role: Role): Promise<void> {
    if (selectedUsers.size === 0) return;
    if (!(await confirmDialog(`Set "${role.name}" as the only role for ${selectedUsers.size} selected user(s)?`, { variant: 'default', confirmLabel: 'Apply' })))
      return;
    bulkApplying = true;
    try {
      for (const username of selectedUsers) await updateUserRoles(username, [role.id]);
      selectedUsers = new Set();
      void load();
    } finally {
      bulkApplying = false;
    }
  }

  const filteredAuditLog = $derived.by(() => {
    const needle = auditSearch.trim().toLowerCase();
    if (!needle) return auditLog ?? [];
    return (auditLog ?? []).filter(
      (e) =>
        e.actor.toLowerCase().includes(needle) ||
        e.target.toLowerCase().includes(needle) ||
        AUDIT_ACTION_LABEL[e.action].toLowerCase().includes(needle) ||
        (e.detail ?? '').toLowerCase().includes(needle),
    );
  });

  async function load(): Promise<void> {
    const [u, r, a] = await Promise.all([fetchUsers(), fetchRoles(), fetchAuditLog(200)]);
    users = u.users;
    roles = r.roles;
    auditLog = a.entries;
  }

  $effect(() => {
    void load();
  });

  function openAdd(): void {
    username = '';
    newRoleIds = [];
    addOpen = true;
    // Settings subtabs stay mounted (just hidden) once visited, so a role created while this tab
    // wasn't showing wouldn't otherwise show up here until some other reload happened to fire.
    void load();
  }

  function toggleNewRole(id: string): void {
    newRoleIds = newRoleIds.includes(id) ? newRoleIds.filter((r) => r !== id) : [...newRoleIds, id];
  }

  async function submit(): Promise<void> {
    const name = username.trim();
    if (!name) return;
    submitting = true;
    try {
      const { ok } = await addUser(name, newRoleIds);
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
  let manageRoleIds = $state<string[]>([]);
  let managePriority = $state('0');

  function openManage(u: AllowedUser): void {
    manageUser = u;
    manageRoleIds = [...u.roleIds];
    managePriority = String(u.priority ?? 0);
    manageOpen = true;
    void load();
  }

  function toggleManageRole(id: string): void {
    manageRoleIds = manageRoleIds.includes(id) ? manageRoleIds.filter((r) => r !== id) : [...manageRoleIds, id];
  }

  const rolesUnchanged = $derived.by(() => {
    if (!manageUser) return true;
    const sameRoles =
      manageRoleIds.length === manageUser.roleIds.length && manageRoleIds.every((id) => manageUser?.roleIds.includes(id));
    return sameRoles && Number(managePriority) === (manageUser.priority ?? 0);
  });

  async function saveRoles(): Promise<void> {
    if (!manageUser || rolesUnchanged) return;
    savingRoles = true;
    try {
      const { ok } = await updateUserRoles(manageUser.username, manageRoleIds, Number(managePriority));
      if (ok) {
        manageOpen = false;
        void load();
      }
    } finally {
      savingRoles = false;
    }
  }

  async function removeManaged(): Promise<void> {
    if (!manageUser) return;
    if (!(await confirmDialog(`Remove ${manageUser.username} from the allowlist? Any API keys they own are revoked too.`))) return;
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
    {#if canManage && selectedUsers.size > 0 && assignableRoles.length > 0}
      <div class="mb-3 flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted">Set role for {selectedUsers.size} selected:</span>
        {#each assignableRoles as role (role.id)}
          <Button size="sm" variant="secondary" loading={bulkApplying} onclick={() => applyRoleToSelected(role)}>
            {role.name}
          </Button>
        {/each}
      </div>
    {/if}
    <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
      <table class="min-w-[480px]">
        <thead>
          <tr>
            {#if canManage}
              <th><input type="checkbox" checked={selectableUsers.length > 0 && selectedUsers.size === selectableUsers.length} onchange={toggleSelectAllUsers} /></th>
            {/if}
            <th>Username</th>
            <th>Roles</th>
            <th>Added</th>
            <th>Last active</th>
            {#if canManage}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#if users === null}
            <SkeletonRows rows={3} colspan={canManage ? 6 : 4} />
          {:else}
            {#each filteredUsers as u (u.username)}
              {@const isSelf = u.username === (sessionState.sub ?? '').toLowerCase()}
              <tr>
                {#if canManage}
                  <td>
                    {#if !isSelf}
                      <input type="checkbox" checked={selectedUsers.has(u.username)} onchange={() => toggleSelectUser(u.username)} />
                    {/if}
                  </td>
                {/if}
                <td>{u.username}{#if isSelf}<span class="ml-1.5 text-xs text-muted">(you)</span>{/if}</td>
                <td>
                  <div class="flex flex-wrap gap-1">
                    {#if u.roleIds.length === 0}
                      <Badge variant="secondary">@everyone only</Badge>
                    {:else}
                      {#each u.roleIds as id (id)}
                        {@const role = roleById(id)}
                        {#if role}
                          <Badge style="background-color: {role.color}22; color: {role.color}; border: 1px solid {role.color}55">
                            {role.name}
                          </Badge>
                        {/if}
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
    {#if (auditLog?.length ?? 0) > 5}
      <Input placeholder="Search by actor, action, target, or detail…" bind:value={auditSearch} class="mb-3 max-w-xs" />
    {/if}
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
            {#each filteredAuditLog as entry (entry.id)}
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
    {:else if auditLog !== null && filteredAuditLog.length === 0}
      <EmptyState icon={ScrollText} message={`No changes match "${auditSearch}".`} />
    {/if}
  </Card>
</div>

{#if canManage}
  <Dialog open={addOpen} onOpenChange={(v) => (addOpen = v)} class="max-w-md">
    <div class="mb-3 text-sm font-medium">Add an allowed GitHub user</div>
    <label for="user-username" class="mb-1 block text-xs text-muted">GitHub username</label>
    <Input id="user-username" placeholder="e.g. octocat" bind:value={username} />
    <div class="mt-3 max-h-[46vh] overflow-y-auto pr-0.5">
      <div class="mb-1 text-xs text-muted">Roles (everyone also holds @everyone)</div>
      {#if assignableRoles.length === 0}
        <div class="text-xs text-muted">No roles yet - create one on the Roles tab first.</div>
      {:else}
        <div class="border-border flex flex-col divide-y rounded-lg border">
          {#each assignableRoles as role (role.id)}
            <label class="flex cursor-pointer items-center gap-2.5 px-3 py-2">
              <input type="checkbox" checked={newRoleIds.includes(role.id)} onchange={() => toggleNewRole(role.id)} />
              <span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {role.color}"></span>
              <span class="text-[13px]">{role.name}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
    <Button class="mt-3.5 w-full" loading={submitting} onclick={submit} disabled={!username.trim()}>Add</Button>
  </Dialog>

  <Dialog open={manageOpen} onOpenChange={(v) => (manageOpen = v)} class="max-w-md">
    {#if manageUser}
      <div class="mb-3 text-sm font-medium">Manage {manageUser.username}</div>
      <div class="max-h-[50vh] overflow-y-auto pr-0.5">
        <div class="mb-1 text-xs text-muted">Roles (everyone also holds @everyone)</div>
        {#if assignableRoles.length === 0}
          <div class="text-xs text-muted">No roles yet - create one on the Roles tab first.</div>
        {:else}
          <div class="border-border flex flex-col divide-y rounded-lg border">
            {#each assignableRoles as role (role.id)}
              <label class="flex cursor-pointer items-center gap-2.5 px-3 py-2">
                <input type="checkbox" checked={manageRoleIds.includes(role.id)} onchange={() => toggleManageRole(role.id)} />
                <span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {role.color}"></span>
                <span class="text-[13px]">{role.name}</span>
              </label>
            {/each}
          </div>
        {/if}
        <label for="user-priority" class="mt-3 mb-1 block text-xs text-muted">Queue priority (-5 to 5)</label>
        <Input id="user-priority" type="number" min="-5" max="5" bind:value={managePriority} />
        <div class="mt-1 text-xs text-muted">
          Higher goes first among queued manual decrypts. 0 is the default - most people never need to touch this.
        </div>
      </div>
      <Button class="mt-3.5 w-full" loading={savingRoles} onclick={saveRoles} disabled={rolesUnchanged}>
        Save roles
      </Button>
      <div class="border-border mt-4 border-t pt-4">
        <Button variant="destructive" class="w-full" loading={removing} onclick={removeManaged}>Remove from allowlist</Button>
      </div>
    {/if}
  </Dialog>
{/if}
