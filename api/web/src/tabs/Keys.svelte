<script lang="ts">
  import { PackageSearch } from 'lucide-svelte';
  import CopyButton from '../components/CopyButton.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import KeyUsageDialog from '../components/KeyUsageDialog.svelte';
  import RelativeTime from '../components/RelativeTime.svelte';
  import SkeletonRows from '../components/SkeletonRows.svelte';
  import {
    approveKey,
    bulkApproveKeys,
    bulkExtendKeyExpiry,
    bulkRevokeKeys,
    bulkSetKeyDailyLimit,
    denyKey,
    fetchAllKeys,
    fetchMyKeys,
    fetchPendingKeys,
    regenerateKey,
    requestKey,
    revealKey,
    revokeKey,
    updateKeyPriority,
    type ApiKeyRecord,
  } from '../lib/api';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import Input from '../lib/components/ui/Input.svelte';
  import Select from '../lib/components/ui/Select.svelte';
  import { statusToBadgeVariant } from '../lib/components/ui/variants';
  import { debounce, fmtUntil } from '../lib/format';
  import { scrollFade } from '../lib/scrollFade';
  import { sessionState } from '../lib/session.svelte';
  import { confirmDialog, keyUsageJumpState, showToast } from '../lib/ui.svelte';

  const PAGE_SIZE = 25;

  let keyName = $state('');
  let keyExpiry = $state('never');
  let keyScope = $state('');
  let keyDailyLimit = $state('');
  let revealedKey = $state('');
  let mine = $state<ApiKeyRecord[] | null>(null);
  let pending = $state<ApiKeyRecord[] | null>(null);
  let all = $state<ApiKeyRecord[] | null>(null);
  let allTotal = $state(0);
  let loadingMoreAll = $state(false);
  let statusFilter = $state('all');
  let allSearch = $state('');
  let selected = $state<Set<string>>(new Set());
  let selectedPending = $state<Set<string>>(new Set());
  let submitting = $state(false);
  let busyActions = $state<Set<string>>(new Set());
  let bulkRevoking = $state(false);
  let bulkApproving = $state(false);

  function setBusy(action: string, id: string, busy: boolean): void {
    const key = `${action}:${id}`;
    const next = new Set(busyActions);
    if (busy) next.add(key);
    else next.delete(key);
    busyActions = next;
  }

  function isBusy(action: string, id: string): boolean {
    return busyActions.has(`${action}:${id}`);
  }

  const STALE_MS = 90 * 24 * 60 * 60 * 1000;

  function isStale(k: ApiKeyRecord): boolean {
    if (k.status !== 'approved') return false;
    const lastActivity = k.lastUsedAt ?? k.createdAt;
    return Date.now() - lastActivity > STALE_MS;
  }

  let usageOpen = $state(false);
  let usageKeyId = $state('');
  let usageKeyName = $state('');
  let usageKeyDailyLimit = $state<number | undefined>(undefined);

  function openUsage(k: ApiKeyRecord): void {
    usageKeyId = k.id;
    usageKeyName = k.name;
    usageKeyDailyLimit = k.dailyLimit;
    usageOpen = true;
  }

  const STATUS_OPTIONS = [
    { value: 'all', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'denied', label: 'Denied' },
  ];

  const EXPIRY_OPTIONS = [
    { value: 'never', label: 'Never expires' },
    { value: '1', label: 'In 1 day' },
    { value: '7', label: 'In 7 days' },
    { value: '30', label: 'In 30 days' },
    { value: '90', label: 'In 90 days' },
  ];

  const canApprove = $derived(!!sessionState.permissions?.approveApiKeys);
  const canViewAll = $derived(!!sessionState.permissions?.viewApiKeys);
  const canRevokeAny = $derived(!!sessionState.permissions?.revokeApiKeys);

  async function loadAllKeysPage(): Promise<void> {
    const data = await fetchAllKeys(0, PAGE_SIZE, allSearch);
    all = data.keys;
    allTotal = data.total;
  }

  async function loadMoreKeys(): Promise<void> {
    if (!all) return;
    loadingMoreAll = true;
    try {
      const data = await fetchAllKeys(all.length, PAGE_SIZE, allSearch);
      all = [...all, ...data.keys];
      allTotal = data.total;
    } finally {
      loadingMoreAll = false;
    }
  }

  const debouncedSearchAllKeys = debounce(() => void loadAllKeysPage(), 300);

  $effect(() => {
    void allSearch;
    debouncedSearchAllKeys();
  });

  async function loadAll(): Promise<void> {
    mine = (await fetchMyKeys()).keys;
    if (canApprove) pending = (await fetchPendingKeys()).keys;
    if (canViewAll) await loadAllKeysPage();
  }

  $effect(() => {
    void loadAll();
  });

  $effect(() => {
    const keyId = keyUsageJumpState.keyId;
    if (!keyId) return;
    const match = mine?.find((k) => k.id === keyId) ?? all?.find((k) => k.id === keyId);
    if (!match) return;
    openUsage(match);
    keyUsageJumpState.keyId = null;
  });

  function parseScope(raw: string): string[] | undefined {
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  }

  async function submitRequest(): Promise<void> {
    const name = keyName.trim();
    if (!name) return;
    submitting = true;
    try {
      const expiresInDays = keyExpiry === 'never' ? undefined : Number(keyExpiry);
      const dailyLimit = keyDailyLimit.trim() ? Number(keyDailyLimit) : undefined;
      const { ok, data } = await requestKey(name, expiresInDays, parseScope(keyScope), dailyLimit);
      if (!ok) return;
      keyName = '';
      keyScope = '';
      keyDailyLimit = '';
      if (data.key) {
        revealedKey = data.key;
        showToast('Key created', 'success');
      } else {
        showToast('Request submitted - waiting on admin approval', 'success');
      }
      void loadAll();
    } finally {
      submitting = false;
    }
  }

  function curlExample(key: string): string {
    const base = sessionState.publicBaseUrl ?? location.origin;
    return `curl -H "Authorization: Bearer ${key}" "${base}/v1/decrypt?bundleId=com.example.app" -o app.ipa`;
  }

  async function doReveal(id: string): Promise<void> {
    setBusy('reveal', id, true);
    try {
      const { ok, data } = await revealKey(id);
      if (!ok) return;
      revealedKey = data.key;
      void loadAll();
    } finally {
      setBusy('reveal', id, false);
    }
  }

  async function doRegenerate(id: string): Promise<void> {
    if (!(await confirmDialog('Regenerate this key? The old secret stops working immediately.'))) return;
    setBusy('regenerate', id, true);
    try {
      const { ok } = await regenerateKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('regenerate', id, false);
    }
  }

  async function doRevoke(id: string): Promise<void> {
    if (!(await confirmDialog('Revoke this key? Access is cut off immediately.'))) return;
    setBusy('revoke', id, true);
    try {
      const { ok } = await revokeKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('revoke', id, false);
    }
  }

  async function doApprove(id: string): Promise<void> {
    setBusy('approve', id, true);
    try {
      const { ok } = await approveKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('approve', id, false);
    }
  }

  async function savePriority(id: string, priority: number): Promise<void> {
    setBusy('priority', id, true);
    try {
      await updateKeyPriority(id, priority);
      void loadAll();
    } finally {
      setBusy('priority', id, false);
    }
  }

  async function doDeny(id: string): Promise<void> {
    setBusy('deny', id, true);
    try {
      const { ok } = await denyKey(id);
      if (ok) void loadAll();
    } finally {
      setBusy('deny', id, false);
    }
  }

  function toggleSelect(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleSelectPending(id: string): void {
    const next = new Set(selectedPending);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedPending = next;
  }

  const filteredAll = $derived((all ?? []).filter((k) => statusFilter === 'all' || k.status === statusFilter));

  async function bulkRevoke(): Promise<void> {
    if (selected.size === 0) return;
    if (!(await confirmDialog(`Revoke ${selected.size} key(s)? This can't be undone.`))) return;
    bulkRevoking = true;
    try {
      await bulkRevokeKeys([...selected]);
      selected = new Set();
      void loadAll();
    } finally {
      bulkRevoking = false;
    }
  }

  let bulkExtendDays = $state('30');
  let bulkExtending = $state(false);

  async function bulkExtend(): Promise<void> {
    const days = Number(bulkExtendDays);
    if (selected.size === 0 || !Number.isFinite(days) || days <= 0) return;
    bulkExtending = true;
    try {
      await bulkExtendKeyExpiry([...selected], days);
      selected = new Set();
      void loadAll();
    } finally {
      bulkExtending = false;
    }
  }

  let bulkDailyLimit = $state('');
  let bulkSettingLimit = $state(false);

  async function bulkSetLimit(): Promise<void> {
    if (selected.size === 0) return;
    const trimmed = bulkDailyLimit.trim();
    const limit = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isFinite(limit) || (limit as number) <= 0)) return;
    bulkSettingLimit = true;
    try {
      await bulkSetKeyDailyLimit([...selected], limit);
      selected = new Set();
      void loadAll();
    } finally {
      bulkSettingLimit = false;
    }
  }

  async function bulkApprove(): Promise<void> {
    if (selectedPending.size === 0) return;
    bulkApproving = true;
    try {
      await bulkApproveKeys([...selectedPending]);
      selectedPending = new Set();
      void loadAll();
    } finally {
      bulkApproving = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title={canApprove ? 'Get a key' : 'Request a key'}>
    <div class="mb-2.5 text-sm text-muted">
      {canApprove ? "You get it instantly - no approval needed." : 'Needs approval from an admin before it works.'}
    </div>
    <label for="key-name" class="mb-1 block text-xs text-muted">Name</label>
    <Input id="key-name" placeholder="e.g. laptop, ci-runner" bind:value={keyName} />
    <label for="key-expiry" class="mt-3 mb-1 block text-xs text-muted">Expires</label>
    <Select id="key-expiry" items={EXPIRY_OPTIONS} bind:value={keyExpiry} class="w-full" />
    <label for="key-scope" class="mt-3 mb-1 block text-xs text-muted">Restrict to bundle IDs (optional)</label>
    <Input id="key-scope" placeholder="e.g. com.example.app, com.example.app2" bind:value={keyScope} />
    <div class="mt-1 text-xs text-muted">Comma-separated. Leave blank for a key that can decrypt anything.</div>
    <label for="key-daily-limit" class="mt-3 mb-1 block text-xs text-muted">Daily request limit (optional)</label>
    <Input id="key-daily-limit" type="number" min="1" placeholder="e.g. 100" bind:value={keyDailyLimit} />
    <div class="mt-1 text-xs text-muted">Blank = no limit. Over-limit requests get a 429 until the next day.</div>
    <Button class="mt-3" loading={submitting} onclick={submitRequest}>{canApprove ? 'Create' : 'Request'}</Button>
    {#if revealedKey}
      <div class="border-accent bg-panel-muted mt-3 rounded-md border p-2.5 text-xs break-all">
        Save this now, it won't be shown again:<br />
        <code>{revealedKey}</code>
        <CopyButton text={revealedKey} />
        <div class="mt-2">
          <CopyButton text={curlExample(revealedKey)} label="Copy curl example" />
        </div>
      </div>
    {/if}
  </Card>

  <Card title="My keys">
    <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
      <table class="responsive-table sm:min-w-[480px]">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Scope</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#if mine === null}
            <SkeletonRows rows={2} colspan={6} />
          {:else}
            {#each mine as k (k.id)}
              <tr>
                <td data-label="Name">{k.name}</td>
                <td data-label="Status">
                  <div class="flex flex-wrap items-center justify-end gap-1.5">
                    <Badge variant={statusToBadgeVariant(k.status)}>{k.status}</Badge>
                    {#if k.expiresAt}
                      <Badge variant="secondary">expires {fmtUntil(k.expiresAt)}</Badge>
                    {/if}
                    {#if isStale(k)}
                      <Badge variant="secondary" title="Not used in 90+ days">unused 90+d</Badge>
                    {/if}
                    {#if k.dailyLimit}
                      <Badge variant="secondary" title="{k.dailyLimit} requests/day">{k.dailyLimit}/day</Badge>
                    {/if}
                  </div>
                </td>
                <td data-label="Scope" class="max-w-40 truncate text-muted" title={k.allowedBundleIds?.join(', ') ?? ''}>
                  {#if k.allowedBundleIds?.length}
                    {k.allowedBundleIds.length} bundle{k.allowedBundleIds.length === 1 ? '' : 's'}
                  {:else}
                    <span class="text-muted">unrestricted</span>
                  {/if}
                </td>
                <td data-label="Created" class="text-muted"><RelativeTime ms={k.createdAt} /></td>
                <td data-label="Last used" class="text-muted"><RelativeTime ms={k.lastUsedAt} /></td>
                <td>
                  <div class="flex flex-wrap justify-end gap-1.5">
                    {#if k.hasUnrevealedSecret}
                      <Button size="sm" loading={isBusy('reveal', k.id)} onclick={() => doReveal(k.id)}>Reveal</Button>
                    {/if}
                    {#if k.status === 'approved'}
                      <Button size="sm" variant="secondary" onclick={() => openUsage(k)}>Usage</Button>
                      <Button size="sm" variant="secondary" loading={isBusy('regenerate', k.id)} onclick={() => doRegenerate(k.id)}>Regenerate</Button>
                    {/if}
                    <Button size="sm" variant="destructive" loading={isBusy('revoke', k.id)} onclick={() => doRevoke(k.id)}>Revoke</Button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if mine !== null && mine.length === 0}
      <EmptyState icon={PackageSearch} message="No keys yet." />
    {/if}
  </Card>

  {#if canApprove}
    <Card title="Pending requests">
      {#snippet headerExtra()}
        {#if selectedPending.size > 0}
          <Button size="sm" loading={bulkApproving} onclick={bulkApprove}>Approve {selectedPending.size} selected</Button>
        {/if}
      {/snippet}
      <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
        <table class="responsive-table sm:min-w-[480px]">
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Requested by</th>
              <th>Requested</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#if pending === null}
              <SkeletonRows rows={2} colspan={5} />
            {:else}
              {#each pending as k (k.id)}
                <tr>
                  <td data-label="Select"><input type="checkbox" checked={selectedPending.has(k.id)} onchange={() => toggleSelectPending(k.id)} /></td>
                  <td data-label="Name">
                    {k.name}
                    {#if k.expiresAt}
                      <Badge variant="secondary" class="ml-1.5">expires {fmtUntil(k.expiresAt)}</Badge>
                    {/if}
                  </td>
                  <td data-label="Requested by">{k.ownerId}</td>
                  <td data-label="Requested" class="text-muted"><RelativeTime ms={k.createdAt} /></td>
                  <td>
                    <div class="flex justify-end gap-1.5">
                      <Button size="sm" loading={isBusy('approve', k.id)} onclick={() => doApprove(k.id)}>Approve</Button>
                      <Button size="sm" variant="destructive" loading={isBusy('deny', k.id)} onclick={() => doDeny(k.id)}>Deny</Button>
                    </div>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
      {#if pending !== null && pending.length === 0}
        <EmptyState icon={PackageSearch} message="Nothing pending." />
      {/if}
    </Card>
  {/if}

  {#if canViewAll}
    <Card title="All keys">
      {#snippet headerExtra()}
        {#if selected.size > 0}
          <div class="flex flex-wrap items-center gap-1.5">
            {#if canApprove}
              <div class="flex items-center gap-1">
                <Input type="number" min="1" bind:value={bulkExtendDays} class="h-8 w-16 text-xs" aria-label="Days to extend expiry" />
                <Button size="sm" variant="secondary" loading={bulkExtending} onclick={bulkExtend}>Extend expiry</Button>
              </div>
              <div class="flex items-center gap-1">
                <Input type="number" min="1" placeholder="blank = clear" bind:value={bulkDailyLimit} class="h-8 w-28 text-xs" aria-label="New daily limit" />
                <Button size="sm" variant="secondary" loading={bulkSettingLimit} onclick={bulkSetLimit}>Set daily limit</Button>
              </div>
            {/if}
            {#if canRevokeAny}
              <Button size="sm" variant="destructive" loading={bulkRevoking} onclick={bulkRevoke}>Revoke {selected.size} selected</Button>
            {/if}
          </div>
        {/if}
      {/snippet}
      <div class="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Search by name or owner…" bind:value={allSearch} class="w-56" />
        <Select items={STATUS_OPTIONS} bind:value={statusFilter} class="w-44" />
      </div>
      <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
        <table class="responsive-table sm:min-w-[700px]">
          <thead>
            <tr>
              {#if canRevokeAny}<th></th>{/if}
              <th>ID</th>
              <th>Name</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Scope</th>
              {#if canApprove}<th>Priority</th>{/if}
              <th>Created</th>
              <th>Last used</th>
              <th></th>
              {#if canRevokeAny}<th></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#if all === null}
              <SkeletonRows rows={3} colspan={8 + (canRevokeAny ? 2 : 0) + (canApprove ? 1 : 0)} />
            {:else}
              {#each filteredAll as k (k.id)}
                <tr>
                  {#if canRevokeAny}
                    <td data-label="Select"><input type="checkbox" checked={selected.has(k.id)} onchange={() => toggleSelect(k.id)} /></td>
                  {/if}
                  <td data-label="ID">
                    <div class="flex items-center gap-1.5">
                      <code title={k.id}>{k.id.slice(0, 8)}</code>
                      <CopyButton text={k.id} />
                    </div>
                  </td>
                  <td data-label="Name">{k.name}</td>
                  <td data-label="Owner">{k.ownerId}</td>
                  <td data-label="Status">
                    <div class="flex flex-wrap items-center justify-end gap-1.5">
                      <Badge variant={statusToBadgeVariant(k.status)}>{k.status}</Badge>
                      {#if k.expiresAt}
                        <Badge variant="secondary">{fmtUntil(k.expiresAt)}</Badge>
                      {/if}
                      {#if isStale(k)}
                        <Badge variant="secondary" title="Not used in 90+ days">unused 90+d</Badge>
                      {/if}
                      {#if k.dailyLimit}
                        <Badge variant="secondary" title="{k.dailyLimit} requests/day">{k.dailyLimit}/day</Badge>
                      {/if}
                    </div>
                  </td>
                  <td data-label="Scope" class="max-w-32 truncate text-muted" title={k.allowedBundleIds?.join(', ') ?? ''}>
                    {#if k.allowedBundleIds?.length}
                      {k.allowedBundleIds.length} bundle{k.allowedBundleIds.length === 1 ? '' : 's'}
                    {:else}
                      <span class="text-muted">unrestricted</span>
                    {/if}
                  </td>
                  {#if canApprove}
                    <td data-label="Priority">
                      <input
                        type="number"
                        min="-5"
                        max="5"
                        value={k.priority ?? 0}
                        disabled={isBusy('priority', k.id)}
                        onchange={(e) => savePriority(k.id, Number((e.target as HTMLInputElement).value))}
                        class="border-border bg-panel-muted w-14 rounded-md border px-1.5 py-1 text-xs disabled:opacity-60"
                        title="Higher goes first among queued manual decrypts"
                      />
                    </td>
                  {/if}
                  <td data-label="Created" class="text-muted"><RelativeTime ms={k.createdAt} /></td>
                  <td data-label="Last used" class="text-muted"><RelativeTime ms={k.lastUsedAt} /></td>
                  <td>
                    {#if k.status === 'approved'}
                      <Button size="sm" variant="secondary" onclick={() => openUsage(k)}>Usage</Button>
                    {/if}
                  </td>
                  {#if canRevokeAny}
                    <td><Button size="sm" variant="destructive" loading={isBusy('revoke', k.id)} onclick={() => doRevoke(k.id)}>Revoke</Button></td>
                  {/if}
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
      {#if all !== null && filteredAll.length === 0}
        <EmptyState icon={PackageSearch} message="No keys match this filter." />
      {/if}
      {#if all !== null && all.length < allTotal}
        <div class="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={loadingMoreAll} onclick={loadMoreKeys}>
            Load more ({allTotal - all.length} older)
          </Button>
        </div>
      {/if}
    </Card>
  {/if}
</div>

<KeyUsageDialog
  open={usageOpen}
  keyId={usageKeyId}
  keyName={usageKeyName}
  dailyLimit={usageKeyDailyLimit}
  onOpenChange={(v) => (usageOpen = v)}
/>
