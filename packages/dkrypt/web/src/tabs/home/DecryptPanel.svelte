<script lang="ts">
	import { Ellipsis, FlaskConical, History, Star, X } from "lucide-svelte";
	import BatchDecryptDialog from "#components/BatchDecryptDialog.svelte";
	import CopyButton from "#components/CopyButton.svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import JobPreflightDialog from "#components/JobPreflightDialog.svelte";
	import {
		fetchDecryptPreflight,
		fetchJobEta,
		queueDecrypt,
		queueTestFlightDecrypt,
		searchApps,
		type AppStoreSearchResult,
		type DecryptPreflight,
		type TFBuild,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { statusToBadgeVariant } from "#lib/components/ui/variants";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
		primeAppCatalogFromSearch,
	} from "#lib/appCatalog.svelte";
	import {
		addDecrypt,
		isStarredBundleId,
		myDecryptsState,
		pushRecentBundleId,
		recentBundleIdsState,
		removeRecentBundleId,
		starredAppsState,
		toggleStarredApp,
	} from "#lib/decrypts.svelte";
	import { debounce, fmtDurationApprox } from "#lib/format";
	import { liveState } from "#lib/live.svelte";
	import { requestNotificationPermission } from "#lib/notifications";
	import { PermissionFlag } from "#lib/permissions";
	import { sessionHasPermission, sessionState } from "#lib/session.svelte";
	import { showToast } from "#lib/ui.svelte";
	import { cn } from "#lib/utils";
	import TestFlightPickerDialog from "#tabs/home/TestFlightPickerDialog.svelte";
	import VersionPickerDialog from "#tabs/home/VersionPickerDialog.svelte";

	let term = $state("");
	let results = $state<AppStoreSearchResult[]>([]);
	let loading = $state(false);
	let searched = $state(false);
	let highlighted = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let searchToken = 0;
	let queueing = $state<Set<string>>(new Set());
	let resultDetailsOpen = $state<Set<string>>(new Set());
	let preflightOpen = $state(false);
	let preflight = $state<DecryptPreflight | null>(null);
	let pendingQueue = $state<{
		bundleId: string;
		trackName: string;
		externalVersionId?: string;
		versionLabel?: string;
		testflight?: { appId: number; build: TFBuild };
	} | null>(null);

	const statusByBundle = $derived.by(() => {
		const map = new Map<string, string>();
		for (const d of myDecryptsState.items)
			if (!map.has(d.bundleId)) map.set(d.bundleId, d.status);
		for (const j of liveState.overview?.activeJobs ?? [])
			if (!map.has(j.bundleId)) map.set(j.bundleId, j.status);
		return map;
	});

	async function runSearch(q: string): Promise<void> {
		const trimmed = q.trim();
		const token = ++searchToken;
		if (!trimmed) {
			results = [];
			searched = false;
			return;
		}
		loading = true;
		try {
			const data = await searchApps(trimmed);
			if (token !== searchToken) return;
			if ("error" in data) {
				showToast(data.error, "error");
				results = [];
			} else {
				results = data.results;
				primeAppCatalogFromSearch(data.results);
			}
			searched = true;
			highlighted = -1;
		} catch (err) {
			if (token !== searchToken) return;

			const alreadyHandled =
				err instanceof Error &&
				(err.message === "network error" ||
					err.message === "unauthorized");
			if (!alreadyHandled)
				showToast("App Store search failed - try again", "error");
			results = [];
			searched = true;
		} finally {
			if (token === searchToken) loading = false;
		}
	}

	const debouncedSearch = debounce((q: string) => void runSearch(q), 400);

	function onInput(): void {
		if (!term.trim()) {
			debouncedSearch.cancel();
			searchToken++;
			results = [];
			searched = false;
			loading = false;
			return;
		}
		debouncedSearch(term);
	}

	function clearSearch(): void {
		term = "";
		onInput();
		inputEl?.focus();
	}

	const canDecrypt = $derived(
		sessionHasPermission(PermissionFlag.requestDecrypt),
	);

	let versionsOpen = $state(false);
	let versionsBundleId = $state("");
	let versionsTrackName = $state("");

	function openVersions(bundleId: string, trackName: string): void {
		versionsBundleId = bundleId;
		versionsTrackName = trackName;
		versionsOpen = true;
	}

	async function queueNow(request: NonNullable<typeof pendingQueue>): Promise<void> {
		requestNotificationPermission();
		queueing = new Set(queueing).add(request.bundleId);
		try {
			const { ok, data } = request.testflight
				? await queueTestFlightDecrypt(request.bundleId, request.testflight.appId, request.testflight.build, false)
				: await queueDecrypt(request.bundleId, request.externalVersionId, request.versionLabel, false);
			if (!ok) return;
			addDecrypt({
				id: data.id,
				bundleId: request.bundleId,
				trackName: request.trackName,
				versionLabel: request.versionLabel,
				externalVersionId: request.externalVersionId,
				testflight: request.testflight,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
				artifactId: data.artifactId,
				artifactUrl: data.artifactUrl,
			});
			pushRecentBundleId(request.bundleId);
			showToast(`Queued ${request.trackName}${request.versionLabel ? ` (${request.versionLabel})` : ""}`, "success");
		} finally {
			const next = new Set(queueing);
			next.delete(request.bundleId);
			queueing = next;
		}
	}

	async function confirmPreflight(): Promise<void> {
		const request = pendingQueue;
		preflightOpen = false;
		pendingQueue = null;
		preflight = null;
		if (request) await queueNow(request);
	}

	async function queue(
		bundleId: string,
		trackName: string,
		externalVersionId?: string,
		versionLabel?: string,
	): Promise<void> {
		if (!canDecrypt) return;
		try {
			pendingQueue = { bundleId, trackName, externalVersionId, versionLabel };
			preflight = await fetchDecryptPreflight({ bundleId, versionLabel });
			preflightOpen = true;
		} catch {
			pendingQueue = null;
			preflight = null;
			showToast("Could not check device readiness", "error");
		}
	}

	function decryptVersion(
		bundleId: string,
		externalVersionId: string,
		label: string,
	): void {
		versionsOpen = false;
		void queue(bundleId, versionsTrackName, externalVersionId, label);
	}

	let testflightOpen = $state(false);
	let testflightBundleId = $state("");
	let testflightAppId = $state(0);
	let testflightTrackName = $state("");

	function openTestFlight(
		bundleId: string,
		appId: number,
		trackName: string,
	): void {
		testflightBundleId = bundleId;
		testflightAppId = appId;
		testflightTrackName = trackName;
		testflightOpen = true;
	}

	async function decryptTestFlightBuild(
		bundleId: string,
		appId: number,
		build: TFBuild,
		label: string,
	): Promise<void> {
		if (!canDecrypt) return;
		testflightOpen = false;
		try {
			pendingQueue = {
				bundleId,
				trackName: testflightTrackName,
				versionLabel: `TestFlight ${label}`,
				testflight: { appId, build },
			};
			preflight = await fetchDecryptPreflight({ bundleId, versionLabel: `TestFlight ${label}`, testflight: true, installSizeBytes: build.fileSize });
			preflightOpen = true;
		} catch {
			pendingQueue = null;
			preflight = null;
			showToast("Could not check device readiness", "error");
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			const target = highlighted >= 0 ? results[highlighted] : undefined;
			if (target && target.price === 0)
				void queue(target.bundleId, target.trackName);
			else void runSearch(term);
		} else if (e.key === "ArrowDown" && results.length > 0) {
			e.preventDefault();
			highlighted = Math.min(highlighted + 1, results.length - 1);
		} else if (e.key === "ArrowUp" && results.length > 0) {
			e.preventDefault();
			highlighted = Math.max(highlighted - 1, -1);
		}
	}

	function pickRecent(bundleId: string): void {
		term = bundleId;
		void runSearch(bundleId);
	}

	function removeRecent(bundleId: string): void {
		removeRecentBundleId(bundleId);
		showToast("Removed from recents", "success", {
			action: {
				label: "Undo",
				onClick: () => pushRecentBundleId(bundleId),
			},
		});
	}

	function showStarredApp(app: AppStoreSearchResult): void {
		searchToken++;
		debouncedSearch.cancel();
		loading = false;
		results = [app];
		searched = true;
		highlighted = -1;
	}

	let etaByBundle = $state<Record<string, number | null>>({});
	const fetchedEtaBundles = new Set<string>();

	$effect(() => {
		for (const r of results) {
			if (fetchedEtaBundles.has(r.bundleId)) continue;
			fetchedEtaBundles.add(r.bundleId);
			fetchJobEta(r.bundleId)
				.then((res) => {
					etaByBundle[r.bundleId] = res.avgMs;
				})
				.catch(() => fetchedEtaBundles.delete(r.bundleId));
		}
	});

	$effect(() => {
		void ensureAppCatalog([
			...recentBundleIdsState.items,
			...results.map((result) => result.bundleId),
		]);
	});

	function decryptButtonTitle(bundleId: string): string | undefined {
		const avg = etaByBundle[bundleId];
		return avg ? `Usually takes ${fmtDurationApprox(avg)}` : undefined;
	}

	function curlFor(bundleId: string): string {
		const base = sessionState.publicBaseUrl ?? location.origin;
		return `curl -H "Authorization: Bearer <YOUR_API_KEY>" "${base}/v1/decrypt?bundleId=${bundleId}" -o ${bundleId}.ipa`;
	}

	function toggleResultDetails(bundleId: string): void {
		const next = new Set(resultDetailsOpen);
		if (next.has(bundleId)) next.delete(bundleId);
		else next.add(bundleId);
		resultDetailsOpen = next;
	}

	export function focusSearch(): void {
		inputEl?.focus();
	}

	let batchOpen = $state(false);

	export function openBatch(): void {
		if (canDecrypt) batchOpen = true;
	}
</script>

<Card title="Decrypt an app">
	{#snippet headerExtra()}
		{#if canDecrypt}
			<Button
				size="sm"
				variant="secondary"
				class="hidden sm:inline-flex"
				onclick={() => (batchOpen = true)}>Batch decrypt</Button
			>
		{/if}
	{/snippet}
	<div class="relative">
		<Input
			bind:ref={inputEl}
			bind:value={term}
			oninput={onInput}
			onkeydown={onKeydown}
			placeholder="Search the App Store to decrypt… (press / to focus)"
			class={term ? "pr-8" : ""}
		/>
		{#if term}
			<button
				class="text-muted hover:text-text absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer"
				onclick={clearSearch}
				aria-label="Clear search"
				title="Clear search"
			>
				<X class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>

	{#if canDecrypt}
		<div class="mt-2.5 flex flex-wrap items-center gap-2 sm:hidden">
			<Button
				size="sm"
				variant="secondary"
				onclick={() => (batchOpen = true)}>Batch decrypt</Button
			>
		</div>
	{:else}
		<div class="mt-2.5 text-xs text-muted sm:hidden">
			View-only access. Ask an admin for decrypt permission.
		</div>
	{/if}

	{#if !term.trim() && starredAppsState.items.length > 0}
		<div class="mt-2.5 flex flex-wrap gap-1.5">
			{#each starredAppsState.items as app (app.bundleId)}
				<span
					class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-1.5 py-1 text-[12px]"
				>
					{#if appIconUrl(app.bundleId)}
						<img
							src={appIconUrl(app.bundleId)}
							alt=""
							class="h-4 w-4 shrink-0 rounded"
						/>
					{/if}
					<button
						class="cursor-pointer"
						onclick={() => showStarredApp(app)}
						title={app.bundleId}
						>{appDisplayName(app.bundleId, app.trackName)}</button
					>
					<button
						class="text-warn hover:text-err cursor-pointer rounded-full p-0.5"
						onclick={() => toggleStarredApp(app)}
						aria-label="Unstar {app.trackName}"
						title="Unstar"
					>
						<Star class="h-3 w-3" fill="currentColor" />
					</button>
				</span>
			{/each}
		</div>
	{/if}

	{#if !term.trim() && recentBundleIdsState.items.length > 0}
		<div class="mt-2.5 flex flex-wrap gap-1.5">
			{#each recentBundleIdsState.items as bundleId (bundleId)}
				<span
					class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-1.5 py-1 text-[11.5px]"
				>
					{#if appIconUrl(bundleId)}
						<img
							src={appIconUrl(bundleId)}
							alt=""
							class="h-4 w-4 shrink-0 rounded"
						/>
					{/if}
					<button
						class="max-w-42 truncate cursor-pointer text-left"
						onclick={() => pickRecent(bundleId)}
						title={bundleId}>{appDisplayName(bundleId)}</button
					>
					<button
						class="text-muted hover:text-err cursor-pointer rounded-full p-0.5"
						onclick={() => removeRecent(bundleId)}
						aria-label="Remove {bundleId} from recents"
						title="Remove from recents"
					>
						<X class="h-3 w-3" />
					</button>
				</span>
			{/each}
		</div>
	{/if}

	<div class="mt-3.5">
		{#if loading}
			<div
				class="border-border bg-panel-muted/35 animate-pulse rounded-xl border p-3"
			>
				<div class="text-sm text-muted">Searching the App Store…</div>
				<div class="mt-2.5 space-y-2">
					{#each Array(3) as _, i (i)}
						<div class="bg-panel-muted h-10 rounded-lg"></div>
					{/each}
				</div>
			</div>
		{:else if searched && results.length === 0}
			<EmptyState message="No results." />
		{:else}
			{#each results as r, i (r.bundleId)}
				<div
					class={cn(
						"border-border flex animate-[glass-surface-in_220ms_cubic-bezier(0.22,1,0.36,1)] items-center gap-3 border-t py-2.5 first:border-t-0 transition-all duration-200",
						i === highlighted && "bg-panel-muted/80 rounded-xl",
					)}
				>
					{#if r.artworkUrl}
						<img
							src={r.artworkUrl}
							alt=""
							class="h-10 w-10 shrink-0 rounded-lg"
						/>
					{/if}
					<div class="min-w-0 flex-1">
						<div class="text-[13px]">
							{appDisplayName(r.bundleId, r.trackName)}
						</div>
						<div
							class="break-words text-xs leading-4 text-muted"
							title={r.bundleId}
						>
							v{r.version} · {r.sellerName}{r.category ? ` · ${r.category}` : ""}
						</div>
					</div>
					{#if r.price > 0}
						<Badge
							variant="destructive"
							title="ipadecrypt only supports free apps"
							>Paid</Badge
						>
					{:else}
						<div class="flex shrink-0 items-center gap-1.5">
							<div class="hidden items-center gap-1.5 sm:flex">
								<button
									class={cn(
										"cursor-pointer rounded-md p-1.5",
										isStarredBundleId(r.bundleId)
											? "text-warn"
											: "text-muted hover:text-text",
									)}
									onclick={() => toggleStarredApp(r)}
									aria-label={isStarredBundleId(r.bundleId)
										? `Unstar ${r.bundleId}`
										: `Star ${r.bundleId}`}
									title={isStarredBundleId(r.bundleId)
										? "Unstar"
										: "Star"}
								>
									<Star
										class="h-3.5 w-3.5"
										fill={isStarredBundleId(r.bundleId)
											? "currentColor"
											: "none"}
									/>
								</button>
								<CopyButton
									text={curlFor(r.bundleId)}
									label="curl"
								/>
								{#if canDecrypt}
									<Button
										size="sm"
										variant="secondary"
										onclick={() =>
											openVersions(
												r.bundleId,
												appDisplayName(
													r.bundleId,
													r.trackName,
												),
											)}
										title="Browse version history"
										aria-label="Browse version history"
									>
										<History class="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="secondary"
										onclick={() =>
											openTestFlight(
												r.bundleId,
												r.trackId,
												appDisplayName(
													r.bundleId,
													r.trackName,
												),
											)}
										title="Browse TestFlight builds"
										aria-label="Browse TestFlight builds"
									>
										<FlaskConical class="h-3.5 w-3.5" />
									</Button>
								{/if}
							</div>
							{#if statusByBundle.has(r.bundleId)}
								{@const status =
									statusByBundle.get(r.bundleId) ?? ""}
								<Badge variant={statusToBadgeVariant(status)}
									>{status}</Badge
								>
							{:else if canDecrypt}
								<Button
									size="sm"
									loading={queueing.has(r.bundleId)}
									onclick={() =>
										queue(r.bundleId, r.trackName)}
									title={decryptButtonTitle(r.bundleId)}
								>
									Decrypt
								</Button>
							{:else}
								<Badge
									variant="secondary"
									title="Viewers can't queue decrypts"
									>view only</Badge
								>
							{/if}
							<Button
								size="sm"
								variant="secondary"
								class="sm:hidden"
								onclick={() => toggleResultDetails(r.bundleId)}
								aria-expanded={resultDetailsOpen.has(
									r.bundleId,
								)}
								aria-label="More actions for {r.trackName}"
								title="More actions"
							>
								<Ellipsis class="h-3.5 w-3.5" />
							</Button>
						</div>
					{/if}
				</div>
				{#if r.price === 0 && resultDetailsOpen.has(r.bundleId)}
					<div
						class="border-border flex flex-wrap items-center gap-1.5 border-t py-2 sm:hidden"
					>
						<button
							class={cn(
								"cursor-pointer rounded-md p-1.5",
								isStarredBundleId(r.bundleId)
									? "text-warn"
									: "text-muted hover:text-text",
							)}
							onclick={() => toggleStarredApp(r)}
							aria-label={isStarredBundleId(r.bundleId)
								? `Unstar ${r.bundleId}`
								: `Star ${r.bundleId}`}
							title={isStarredBundleId(r.bundleId)
								? "Unstar"
								: "Star"}
						>
							<Star
								class="h-3.5 w-3.5"
								fill={isStarredBundleId(r.bundleId)
									? "currentColor"
									: "none"}
							/>
						</button>
						<CopyButton text={curlFor(r.bundleId)} label="curl" />
						{#if canDecrypt}
							<Button
								size="sm"
								variant="secondary"
								onclick={() =>
									openVersions(
										r.bundleId,
										appDisplayName(r.bundleId, r.trackName),
									)}
							>
								<History class="h-3.5 w-3.5" />
								Versions
							</Button>
							<Button
								size="sm"
								variant="secondary"
								onclick={() =>
									openTestFlight(
										r.bundleId,
										r.trackId,
										appDisplayName(r.bundleId, r.trackName),
									)}
							>
								<FlaskConical class="h-3.5 w-3.5" />
								TestFlight
							</Button>
						{/if}
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</Card>

<VersionPickerDialog
	open={versionsOpen}
	bundleId={versionsBundleId}
	trackName={versionsTrackName}
	onOpenChange={(v) => (versionsOpen = v)}
	onDecrypt={decryptVersion}
/>

<TestFlightPickerDialog
	open={testflightOpen}
	bundleId={testflightBundleId}
	appId={testflightAppId}
	trackName={testflightTrackName}
	onOpenChange={(v) => (testflightOpen = v)}
	onDecrypt={decryptTestFlightBuild}
/>

<BatchDecryptDialog open={batchOpen} onOpenChange={(v) => (batchOpen = v)} />

<JobPreflightDialog
	open={preflightOpen}
	preflight={preflight}
	onOpenChange={(v) => {
		preflightOpen = v;
		if (!v) {
			pendingQueue = null;
			preflight = null;
		}
	}}
	onConfirm={() => void confirmPreflight()}
/>
