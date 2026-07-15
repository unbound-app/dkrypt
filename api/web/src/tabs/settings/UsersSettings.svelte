<script lang="ts">
  import RelativeTime from '../../components/RelativeTime.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { addUser, fetchUsers, removeUser, type AllowedUser, type Role } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import Select from '../../lib/components/ui/Select.svelte';
  import { sessionState } from '../../lib/session.svelte';
  import { confirmDialog, showToast } from '../../lib/ui.svelte';

  let username = $state('');
  let role = $state<Role>('member');
  let users = $state<AllowedUser[] | null>(null);

  const ROLE_OPTIONS = [
    { value: 'member', label: 'member (read-only + own API keys)' },
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

  async function remove(name: string): Promise<void> {
    if ((sessionState.sub ?? '').toLowerCase() === name.toLowerCase()) {
      showToast("You can't remove your own account - ask another admin.", 'error');
      return;
    }
    if (!(await confirmDialog(`Remove ${name} from the allowlist?`))) return;
    const { ok } = await removeUser(name);
    if (ok) void load();
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
              <tr>
                <td>{u.username}</td>
                <td><Badge variant={u.role === 'admin' ? 'success' : 'default'}>{u.role}</Badge></td>
                <td class="text-muted"><RelativeTime ms={u.addedAt} /></td>
                <td>
                  {#if u.username === (sessionState.sub ?? '').toLowerCase()}
                    <span class="text-xs text-muted">(you)</span>
                  {:else}
                    <Button size="sm" variant="destructive" onclick={() => remove(u.username)}>Remove</Button>
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
