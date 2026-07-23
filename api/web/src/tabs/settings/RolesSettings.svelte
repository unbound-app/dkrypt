<script lang="ts">
  import { ArrowDown, ArrowUp, Plus, Shield, X } from 'lucide-svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PermissionEditor from '../../components/PermissionEditor.svelte';
  import {
    createDiscordRolePerk,
    createRole,
    deleteDiscordRolePerk,
    deleteRole,
    fetchDiscordGuildRoles,
    fetchDiscordGuilds,
    fetchDiscordRolePerks,
    fetchDiscordStatus,
    fetchRoles,
    fetchUsers,
    reorderRoles,
    setDiscordGuilds,
    updateRole,
    type AllowedUser,
    type DiscordGuildSummary,
    type DiscordGuildRole,
    type DiscordRolePerk,
    type Role,
  } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import SearchSelect from '../../lib/components/ui/SearchSelect.svelte';
  import Select from '../../lib/components/ui/Select.svelte';
  import { parseBits, permissionLabels, PermissionFlag, serializeBits } from '../../lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission } from '../../lib/session.svelte';
  import { confirmDialog } from '../../lib/ui.svelte';

  const canViewRoles = $derived(sessionHasAnyPermission([PermissionFlag.viewRoles, PermissionFlag.manageRoles]));
  const canManageRoles = $derived(sessionHasPermission(PermissionFlag.manageRoles));
  const canViewDiscordPerks = $derived(sessionHasAnyPermission([PermissionFlag.viewDiscordPerks, PermissionFlag.manageDiscordPerks]));
  const canManageDiscordPerks = $derived(sessionHasPermission(PermissionFlag.manageDiscordPerks));

  const COLOR_PRESETS = ['#99aab5', '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#5865f2', '#2ecc71'];

  let roles = $state<Role[] | null>(null);
  let users = $state<AllowedUser[] | null>(null);
  let reordering = $state(false);

  // Highest position first, like Discord's role list - the default @everyone role always sorts last.
  const displayRoles = $derived.by(() => {
    if (!roles) return [];
    return [...roles].sort((a, b) => b.position - a.position);
  });

  function memberCount(roleId: string): number {
    return (users ?? []).filter((u) => u.roleIds.includes(roleId)).length;
  }

  async function load(): Promise<void> {
    const [r, u] = await Promise.all([
      canViewRoles ? fetchRoles() : Promise.resolve({ roles: [] }),
      sessionHasAnyPermission([PermissionFlag.viewUsers, PermissionFlag.manageUsers]) ? fetchUsers() : Promise.resolve({ users: [] }),
    ]);
    roles = r.roles;
    users = u.users;
  }

  $effect(() => {
    void load();
  });

  let dialogOpen = $state(false);
  let editingRole = $state<Role | null>(null);
  let formName = $state('');
  let formColor = $state(COLOR_PRESETS[0]);
  let formBits = $state(0n);
  let saving = $state(false);
  let deletingId = $state<string | null>(null);

  function openAdd(): void {
    editingRole = null;
    formName = '';
    formColor = COLOR_PRESETS[Math.floor(Math.random() * COLOR_PRESETS.length)];
    formBits = 0n;
    dialogOpen = true;
  }

  function openEdit(r: Role): void {
    editingRole = r;
    formName = r.name;
    formColor = r.color;
    formBits = parseBits(r.permissions);
    dialogOpen = true;
  }

  async function save(): Promise<void> {
    if (!formName.trim()) return;
    saving = true;
    try {
      const { ok } = editingRole
        ? await updateRole(editingRole.id, { name: formName.trim(), color: formColor, permissions: serializeBits(formBits) })
        : await createRole(formName.trim(), formColor, serializeBits(formBits));
      if (ok) {
        dialogOpen = false;
        void load();
      }
    } finally {
      saving = false;
    }
  }

  async function remove(r: Role): Promise<void> {
    if (!(await confirmDialog(`Delete the "${r.name}" role? Anyone holding it loses what it grants.`))) return;
    deletingId = r.id;
    try {
      const { ok } = await deleteRole(r.id, r.name);
      if (ok) void load();
    } finally {
      deletingId = null;
    }
  }

  async function move(role: Role, direction: 'up' | 'down'): Promise<void> {
    if (!roles) return;
    // Ascending by position (index 0 = lowest, excluding the default role which never reorders).
    const ascending = roles.filter((r) => !r.isDefault).sort((a, b) => a.position - b.position);
    const idx = ascending.findIndex((r) => r.id === role.id);
    const swapWith = direction === 'up' ? idx + 1 : idx - 1;
    if (idx === -1 || swapWith < 0 || swapWith >= ascending.length) return;
    [ascending[idx], ascending[swapWith]] = [ascending[swapWith], ascending[idx]];
    reordering = true;
    try {
      const { ok, data } = await reorderRoles(ascending.map((r) => r.id));
      if (ok) roles = data.roles;
    } finally {
      reordering = false;
    }
  }

  // --- Discord role perks ------------------------------------------------------------------

  let discordBotEnabled = $state(false);
  let discordGuilds = $state<DiscordGuildSummary[] | null>(null);
  let selectedDiscordGuilds = $state<DiscordGuildSummary[]>([]);
  let discordRoles = $state<DiscordGuildRole[] | null>(null);
  let discordPerks = $state<DiscordRolePerk[] | null>(null);
  let savingGuild = $state(false);
  let addingPerk = $state(false);
  let deletingPerkId = $state<string | null>(null);
  let perkGuildId = $state('');
  let perkDiscordRoleId = $state('');
  let perkAppRoleId = $state('');

  async function loadDiscordStatus(): Promise<void> {
    const status = await fetchDiscordStatus();
    discordBotEnabled = status.botEnabled;
    if (!discordBotEnabled) return;
    const [guildsRes, perksRes] = await Promise.all([fetchDiscordGuilds(), fetchDiscordRolePerks()]);
    discordGuilds = guildsRes.guilds;
    selectedDiscordGuilds = status.guilds;
    discordPerks = perksRes.perks;
    if (!selectedDiscordGuilds.some((guild) => guild.id === perkGuildId)) {
      perkGuildId = selectedDiscordGuilds[0]?.id ?? '';
    }
    await loadDiscordRoles(perkGuildId);
  }

  $effect(() => {
    if (canViewDiscordPerks) void loadDiscordStatus();
  });

  async function loadDiscordRoles(guildId: string): Promise<void> {
    if (!guildId) {
      discordRoles = [];
      return;
    }
    discordRoles = null;
    const { roles } = await fetchDiscordGuildRoles(guildId);
    if (guildId === perkGuildId) discordRoles = roles;
  }

  async function pickGuild(guildId: string): Promise<void> {
    const guild = discordGuilds?.find((item) => item.id === guildId);
    if (!guild || selectedDiscordGuilds.some((item) => item.id === guild.id)) return;
    if (!(await confirmDialog(`Add ${guild.name} as a Discord role-perk guild? Its configured Discord roles can then grant dashboard roles on sign-in.`, { confirmLabel: 'Add guild' }))) return;
    savingGuild = true;
    try {
      const { ok } = await setDiscordGuilds([...selectedDiscordGuilds, guild]);
      if (ok) void loadDiscordStatus();
    } finally {
      savingGuild = false;
    }
  }

  async function removeGuild(guildId: string): Promise<void> {
    const guild = selectedDiscordGuilds.find((item) => item.id === guildId);
    if (!guild || !(await confirmDialog(`Remove ${guild.name} from Discord role perks? Its mappings will stop granting dashboard roles on future Discord sign-ins.`, { variant: 'destructive', confirmLabel: 'Remove guild' }))) return;
    savingGuild = true;
    try {
      const { ok } = await setDiscordGuilds(selectedDiscordGuilds.filter((guild) => guild.id !== guildId));
      if (ok) void loadDiscordStatus();
    } finally {
      savingGuild = false;
    }
  }

  const assignableRoles = $derived((roles ?? []).filter((r) => !r.isDefault));
  const perkAppRoleOptions = $derived(assignableRoles.map((r) => ({ value: r.id, label: r.name, color: r.color })));

  function appRoleName(id: string): string {
    return roles?.find((r) => r.id === id)?.name ?? id;
  }

  function appRoleColor(id: string): string | undefined {
    return roles?.find((r) => r.id === id)?.color;
  }

  async function addPerk(): Promise<void> {
    const guild = selectedDiscordGuilds.find((item) => item.id === perkGuildId);
    const discordRole = discordRoles?.find((item) => item.id === perkDiscordRoleId);
    if (!guild || !discordRole || !perkAppRoleId) return;
    if (!(await confirmDialog(`Map the Discord role ${discordRole.name} to the dashboard role ${appRoleName(perkAppRoleId)}? Members receive that dashboard role when they sign in with Discord.`, { confirmLabel: 'Create mapping' }))) return;
    addingPerk = true;
    try {
      const { ok } = await createDiscordRolePerk(guild, discordRole, perkAppRoleId);
      if (ok) {
        perkDiscordRoleId = '';
        perkAppRoleId = '';
        void loadDiscordStatus();
      }
    } finally {
      addingPerk = false;
    }
  }

  async function removePerk(perk: DiscordRolePerk): Promise<void> {
    if (!(await confirmDialog(`Remove the mapping from ${perk.discordRoleName ?? perk.discordRoleId} to ${appRoleName(perk.appRoleId)}? Future Discord sign-ins will no longer receive that dashboard role from this perk.`, { variant: 'destructive', confirmLabel: 'Remove mapping' }))) return;
    deletingPerkId = perk.id;
    try {
      const { ok } = await deleteDiscordRolePerk(perk.id);
      if (ok) discordPerks = (discordPerks ?? []).filter((p) => p.id !== perk.id);
    } finally {
      deletingPerkId = null;
    }
  }

  function guildIconUrl(guild: DiscordGuildSummary): string | undefined {
    if (!guild.icon) return undefined;
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${guild.icon.startsWith('a_') ? 'gif' : 'png'}?size=64`;
  }

  function discordRoleColor(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
  }

  const availableDiscordGuildOptions = $derived(
    (discordGuilds ?? [])
      .filter((guild) => !selectedDiscordGuilds.some((selected) => selected.id === guild.id))
      .map((guild) => ({ value: guild.id, label: guild.name })),
  );
  const selectedDiscordGuildOptions = $derived(selectedDiscordGuilds.map((guild) => ({ value: guild.id, label: guild.name })));
</script>

<Card title="Roles">
  {#snippet headerExtra()}
    {#if canManageRoles}
      <Button size="sm" onclick={openAdd}>
        <Plus class="h-3.5 w-3.5" />
        Add role
      </Button>
    {/if}
  {/snippet}
  <div class="mb-3 text-sm text-muted">
    Every added user automatically holds <strong>@everyone</strong>. Build additional roles out of individual permission bits, then
    assign them to people on the Users tab - a user's effective access is the union of every role they hold.
  </div>
  {#if roles === null}
    <div class="flex flex-col gap-2">
      {#each Array(3) as _, i (i)}
        <div class="skeleton bg-panel-muted h-14 w-full rounded-lg"></div>
      {/each}
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each displayRoles as r, i (r.id)}
        {@const labels = permissionLabels(parseBits(r.permissions))}
        {@const ascendingIdx = displayRoles.length - 2 - i}
        <div class="border-border rounded-lg border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {r.color}"></span>
              <span class="text-[13px] font-medium">{r.name}</span>
              {#if labels[0] === 'Administrator'}
                <Badge variant="destructive"><Shield class="mr-1 h-3 w-3" />Administrator</Badge>
              {/if}
              <span class="text-xs text-muted">{memberCount(r.id)} member{memberCount(r.id) === 1 ? '' : 's'}</span>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              {#if canManageRoles && !r.isDefault}
                <Button
                  size="icon"
                  variant="secondary"
                  disabled={reordering || ascendingIdx === displayRoles.length - 2}
                  onclick={() => void move(r, 'up')}
                  aria-label="Move {r.name} up"
                  title="Move up"
                >
                  <ArrowUp class="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="secondary"
                  disabled={reordering || ascendingIdx === 0}
                  onclick={() => void move(r, 'down')}
                  aria-label="Move {r.name} down"
                  title="Move down"
                >
                  <ArrowDown class="h-3.5 w-3.5" />
                </Button>
              {/if}
              {#if canManageRoles}
                <Button size="sm" variant="secondary" onclick={() => openEdit(r)}>Edit</Button>
                {#if !r.isDefault}
                  <Button size="sm" variant="destructive" loading={deletingId === r.id} onclick={() => remove(r)}>Delete</Button>
                {/if}
              {/if}
            </div>
          </div>
          {#if labels.length > 0 && labels[0] !== 'Administrator'}
            <div class="mt-1.5 flex flex-wrap gap-1">
              {#each labels as label (label)}
                <Badge variant="secondary">{label}</Badge>
              {/each}
            </div>
          {:else if labels.length === 0}
            <div class="mt-1.5 text-xs text-muted">No permissions granted.</div>
          {/if}
        </div>
      {/each}
    </div>
    {#if roles.length === 0}
      <EmptyState message="No roles yet." />
    {/if}
  {/if}
</Card>

{#if canViewDiscordPerks && discordBotEnabled}
  <Card title="Discord role perks" class="mt-4">
    <div class="mb-3 text-sm text-muted">
      Anyone who holds a mapped role in any selected Discord guild is automatically granted the matching dashboard role, checked on every
      Discord login.
    </div>
    {#if discordGuilds === null}
      <div class="skeleton bg-panel-muted h-10 w-full rounded-lg"></div>
    {:else if discordGuilds.length === 0}
      <EmptyState message="The bot isn't in any guild yet - invite it to your server first." />
    {:else}
      {#if selectedDiscordGuilds.length > 0}
        <div class="mb-3 flex flex-wrap gap-2">
          {#each selectedDiscordGuilds as guild (guild.id)}
            <div class="border-border bg-panel-muted flex items-center gap-2 rounded-md border py-1.5 pr-1.5 pl-2 text-xs">
              {#if guildIconUrl(guild)}
                <img class="h-5 w-5 rounded-full" src={guildIconUrl(guild)} alt="" />
              {:else}
                <span class="bg-accent/15 text-accent flex h-5 w-5 items-center justify-center rounded-full font-semibold">{guild.name.slice(0, 1)}</span>
              {/if}
              <span class="font-medium">{guild.name}</span>
              <button
                type="button"
                class="text-muted hover:text-text rounded p-0.5"
                aria-label="Remove {guild.name}"
                disabled={savingGuild || !canManageDiscordPerks}
                onclick={() => void removeGuild(guild.id)}
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if canManageDiscordPerks && availableDiscordGuildOptions.length > 0}
        <div class="mb-4 flex items-center gap-2">
          <SearchSelect
            items={availableDiscordGuildOptions}
            value=""
            onValueChange={(value) => value && void pickGuild(value)}
            placeholder={selectedDiscordGuilds.length ? 'Add another guild…' : 'Search guilds…'}
            class="w-full"
            disabled={savingGuild}
          />
          {#if savingGuild}<span class="text-xs text-muted">Saving…</span>{/if}
        </div>
      {/if}

      {#if selectedDiscordGuilds.length > 0}
      <div class="mb-3 flex flex-col gap-1.5">
        {#if discordPerks === null}
          <div class="skeleton bg-panel-muted h-10 w-full rounded-lg"></div>
        {:else if discordPerks.length === 0}
          <EmptyState message="No perks configured yet." />
        {:else}
          {#each discordPerks as perk (perk.id)}
            <div class="border-border flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-xs">
              {#if guildIconUrl({ id: perk.guildId, name: perk.guildName ?? perk.guildId, icon: perk.guildIcon })}
                <img class="h-5 w-5 rounded-full" src={guildIconUrl({ id: perk.guildId, name: perk.guildName ?? perk.guildId, icon: perk.guildIcon })} alt="" />
              {:else}
                <span class="bg-accent/15 text-accent flex h-5 w-5 items-center justify-center rounded-full font-semibold">{(perk.guildName ?? perk.guildId).slice(0, 1)}</span>
              {/if}
              <span class="max-w-28 truncate text-muted">{perk.guildName ?? perk.guildId}</span>
              <span class="h-2.5 w-2.5 shrink-0 rounded-full border border-black/20" style="background-color: {discordRoleColor(perk.discordRoleColor)}"></span>
              <span class="font-medium">{perk.discordRoleName ?? perk.discordRoleId}</span>
              <span class="text-muted">grants</span>
              {#if appRoleColor(perk.appRoleId)}<span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {appRoleColor(perk.appRoleId)}"></span>{/if}
              <span class="font-medium">{appRoleName(perk.appRoleId)}</span>
              {#if canManageDiscordPerks}
                <Button
                  size="sm"
                  variant="destructive"
                  class="ml-auto"
                  loading={deletingPerkId === perk.id}
                  onclick={() => void removePerk(perk)}
                >
                  Remove
                </Button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
      {#if canManageDiscordPerks && discordRoles && discordRoles.length > 0 && assignableRoles.length > 0}
        <div class="flex flex-wrap items-center gap-1.5">
          <SearchSelect
            items={selectedDiscordGuildOptions}
            bind:value={perkGuildId}
            onValueChange={(value) => {
              perkDiscordRoleId = '';
              void loadDiscordRoles(value);
            }}
            placeholder="Discord guild…"
            class="w-44"
          />
          <SearchSelect items={discordRoles.map((r) => ({ value: r.id, label: r.name }))} bind:value={perkDiscordRoleId} placeholder="Search Discord roles…" class="w-48" />
          <span class="text-xs text-muted">grants</span>
          <Select items={perkAppRoleOptions} bind:value={perkAppRoleId} placeholder="Dashboard role…" class="w-48 shrink-0" />
          <Button size="sm" loading={addingPerk} disabled={!perkDiscordRoleId || !perkAppRoleId} onclick={addPerk}>Add</Button>
        </div>
      {:else if assignableRoles.length === 0}
        <div class="text-xs text-muted">Add a non-default dashboard role above before mapping Discord perks to it.</div>
      {:else if discordRoles && discordRoles.length === 0}
        <div class="text-xs text-muted">This guild has no assignable Discord roles.</div>
      {/if}
      {:else}
        <div class="text-xs text-muted">Select at least one guild to map its Discord roles.</div>
      {/if}
    {/if}
  </Card>
{/if}

{#if canManageRoles}
  <Dialog open={dialogOpen} onOpenChange={(v) => (dialogOpen = v)} class="max-w-md">
    <div class="mb-3 text-sm font-medium">{editingRole ? `Edit ${editingRole.name}` : 'Add role'}</div>
    <div class="max-h-[65vh] overflow-y-auto pr-0.5">
      <label for="r-name" class="mb-1 block text-xs text-muted">Name</label>
      <Input id="r-name" placeholder="e.g. Key Manager" bind:value={formName} disabled={editingRole?.isDefault} />

      <div class="mt-3 mb-1 text-xs text-muted">Color</div>
      <div class="flex flex-wrap gap-1.5">
        {#each COLOR_PRESETS as c (c)}
          <button
            type="button"
            class="h-6 w-6 cursor-pointer rounded-full border-2"
            style="background-color: {c}; border-color: {formColor === c ? 'var(--color-text)' : 'transparent'};"
            onclick={() => (formColor = c)}
            aria-label="Color {c}"
          ></button>
        {/each}
      </div>

      <div class="mt-3.5">
        <PermissionEditor bind:value={formBits} />
      </div>
    </div>
    <Button class="mt-3.5 w-full" loading={saving} onclick={save} disabled={!formName.trim()}>{editingRole ? 'Save' : 'Add'}</Button>
  </Dialog>
{/if}
