<script lang="ts">
  import RelativeTime from '../../components/RelativeTime.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { addUser, fetchUsers, removeUser, updateUserRole, type AllowedUser, type Role } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import Select from '../../lib/components/ui/Select.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { sessionState } from '../../lib/session.svelte';
  import { confirmDialog } from '../../lib/ui.svelte';

  let username = $state('');
  let role = $state<Role>('member');
  let users = $state<AllowedUser[] | null>(null);

  const ROLE_OPTIONS = [
    { value: 'viewer', label: 'viewer (read-only)' },
    { value: 'member', label: 'member (queue decrypts + own API keys)' },
    { value: 'operator', label: 'operator (admin, minus Users & Settings)' },
    { value: 'admin', label: 'admin (full access)' },
  ];

  async function load(): Promise<void> {
    users = (await fetchUsers()).users;
  }

  $effect(() => {
    void load();
  });

  async function submit(): Promise<void> {
    const name = username.trim();
    if (!name) return;
    const { ok } = await addUser(name, role);
    if (ok) {
      username = '';
      void load();
    }
  }

  let manageOpen = $state(false);
  let manageUser = $state<AllowedUser | null>(null);
  let manageRole = $state<Role>('member');

  function openManage(u: AllowedUser): void {
    manageUser = u;
    manageRole = u.role;
    manageOpen = true;
  }

  async function saveRole(): Promise<void> {
    if (!manageUser || manageRole === manageUser.role) return;
    const { ok } = await updateUserRole(manageUser.username, manageRole);
    if (ok) {
      manageOpen = false;
      void load();
    }
  }

  async function removeManaged(): Promise<void> {
    if (!manageUser) return;
    if (!(await confirmDialog(`Remove ${manageUser.username} from the allowlist?`))) return;
    const { ok } = await removeUser(manageUser.username);
    if (ok) {
      manageOpen = false;
      void load();
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title="Add an allowed GitHub user">
    <label for="user-username" class="mb-1 block text-xs text-muted">GitHub username</label>
    <Input id="user-username" placeholder="e.g. octocat" bind:value={username} />
    <label for="user-role" class="mt-3 mb-1 block text-xs text-muted">Role</label>
    <Select items={ROLE_OPTIONS} value={role} onValueChange={(v) => (role = v as Role)} class="w-full" />
    <Button class="mt-4" onclick={submit}>Add</Button>
  </Card>

  <Card title="Allowlist">
    <div class="overflow-x-auto">
      <table class="min-w-[480px]">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#if users === null}
            <SkeletonRows rows={3} colspan={4} />
          {:else}
            {#each users as u (u.username)}
              {@const isSelf = u.username === (sessionState.sub ?? '').toLowerCase()}
              <tr>
                <td>{u.username}</td>
                <td><Badge variant={statusToBadgeVariant(u.role)}>{u.role}</Badge></td>
                <td class="text-muted"><RelativeTime ms={u.addedAt} /></td>
                <td>
                  {#if isSelf}
                    <span class="text-xs text-muted">(you)</span>
                  {:else}
                    <Button size="sm" variant="secondary" onclick={() => openManage(u)}>Manage</Button>
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </Card>
</div>

<Dialog open={manageOpen} onOpenChange={(v) => (manageOpen = v)} class="max-w-sm">
  {#if manageUser}
    <div class="mb-3 text-sm font-medium">Manage {manageUser.username}</div>
    <label for="manage-role" class="mb-1 block text-xs text-muted">Role</label>
    <Select id="manage-role" items={ROLE_OPTIONS} value={manageRole} onValueChange={(v) => (manageRole = v as Role)} class="w-full" />
    <Button class="mt-3 w-full" onclick={saveRole} disabled={manageRole === manageUser.role}>Save role</Button>
    <div class="border-border mt-4 border-t pt-4">
      <Button variant="destructive" class="w-full" onclick={removeManaged}>Remove from allowlist</Button>
    </div>
  {/if}
</Dialog>
