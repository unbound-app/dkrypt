<script lang="ts">
	import { Eye, History, X } from "lucide-svelte";
	import BundleStatsDialog from "#components/BundleStatsDialog.svelte";
	import BulkJobPreviewDialog from "#components/BulkJobPreviewDialog.svelte";
	import AppIcon from "#components/AppIcon.svelte";
	import JobDetailsDialog from "#components/JobDetailsDialog.svelte";
	import CopyButton from "#components/CopyButton.svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import ShareLinkDialog from "#components/ShareLinkDialog.svelte";
	import {
		fetchJobHistory,
		jobHistoryExportUrl,
		previewBulkJobReplay,
		queueDecrypt,
		queueTestFlightDecrypt,
		retryJob,
		type BulkJobPreview,
		type JobHistoryEntry,
	} from "#lib/api";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import {
		buttonVariants,
		statusToBadgeVariant,
	} from "#lib/components/ui/variants";
	import { addDecrypt, pushRecentBundleId } from "#lib/decrypts.svelte";
	import { csvCell, debounce, downloadBlob, fmtSize } from "#lib/format";
	import { liveState } from "#lib/live.svelte";
	import { createSavedViews } from "#lib/savedViews.svelte";
	import { sessionState } from "#lib/session.svelte";
	import {
		historyJumpState,
		requestFocusSearch,
		showToast,
		tabState,
	} from "#lib/ui.svelte";
	import { getQueryParam, setQueryParams } from "#lib/urlState";

	const PAGE_SIZE = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches ? 8 : 15;

	type SourceFilter = "all" | "manual" | "scheduler";
	type StatusFilter = "all" | "done" | "failed";

	interface FilterPreset {
		name: string;
		query: string;
		source: SourceFilter;
		status: StatusFilter;
		queuedBy: string;
		deviceId: string;
		errorQ: string;
		failureCategory: string;
	}

	const CANCELLED_RE = /^cancelled by/i;
	const TIMEOUT_RE = /timed? ?out/i;
	const UNREACHABLE_RE =
		/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|no route to host|not reachable|connection closed/i;
	const DISK_RE = /ENOSPC|no space left/i;

	function categorizeFailure(message: string | undefined): string {
		if (!message) return "Unknown";
		if (CANCELLED_RE.test(message)) return "Cancelled";
		if (UNREACHABLE_RE.test(message)) return "Device unreachable";
		if (DISK_RE.test(message)) return "Disk full";
		if (TIMEOUT_RE.test(message)) return "Timed out";
		return "Other";
	}

	let entries = $state<JobHistoryEntry[]>([]);
	let total = $state(0);
	let loaded = $state(false);
	let loadingMore = $state(false);
	let seenIds = new Set<string>();
	let requeueing = $state<Set<string>>(new Set());
	let searchText = $state(
		getQueryParam("hq") ??
			localStorage.getItem("jobHistorySearchText") ??
			"",
	);
	let activeQuery = $state("");
	let sourceFilter = $state<SourceFilter>(
		(getQueryParam("hsource") as SourceFilter | undefined) ??
			(localStorage.getItem(
				"jobHistorySourceFilter",
			) as SourceFilter | null) ??
			"all",
	);
	let statusFilter = $state<StatusFilter>(
		(getQueryParam("hstatus") as StatusFilter | undefined) ??
			(localStorage.getItem(
				"jobHistoryStatusFilter",
			) as StatusFilter | null) ??
			"all",
	);
	let queuedByFilter = $state(
		getQueryParam("hqueuedBy") ??
			localStorage.getItem("jobHistoryQueuedByFilter") ??
			"",
	);
	let deviceFilter = $state(
		getQueryParam("hdevice") ??
			localStorage.getItem("jobHistoryDeviceFilter") ??
			"",
	);
	let errorFilter = $state(
		getQueryParam("herror") ??
			localStorage.getItem("jobHistoryErrorFilter") ??
			"",
	);
	let failureCategoryFilter = $state(
		getQueryParam("hcat") ??
			localStorage.getItem("jobHistoryFailureCategoryFilter") ??
			"",
	);
	let selected = $state<Set<string>>(new Set());
	let bulkRequeueing = $state(false);
	let bulkPreviewOpen = $state(false);
	let bulkPreviewLoading = $state(false);
	let bulkPreview = $state<BulkJobPreview | null>(null);
	const savedViews = createSavedViews<FilterPreset>(
		"jobHistoryFilterPresets",
	);
	let newPresetName = $state("");
	let jobDetailsOpen = $state(Boolean(getQueryParam("job")));
	let jobDetailsId = $state(getQueryParam("job") ?? "");
	let jobDetailsTitle = $state("");

	function applyPreset(p: FilterPreset): void {
		searchText = p.query;
		sourceFilter = p.source;
		statusFilter = p.status;
		queuedByFilter = p.queuedBy;
		deviceFilter = p.deviceId;
		errorFilter = p.errorQ;
		failureCategoryFilter = p.failureCategory ?? "";
	}

	function savePreset(): void {
		const name = newPresetName.trim();
		if (!name) return;
		savedViews.save({
			name,
			query: searchText.trim(),
			source: sourceFilter,
			status: statusFilter,
			queuedBy: queuedByFilter.trim(),
			deviceId: deviceFilter.trim(),
			errorQ: errorFilter.trim(),
			failureCategory: failureCategoryFilter.trim(),
		});
		newPresetName = "";
	}

	function removePreset(name: string): void {
		savedViews.remove(name);
	}

	$effect(() => {
		if (tabState.active !== "home") return;
		setQueryParams({
			hq: searchText.trim() || undefined,
			hsource: sourceFilter === "all" ? undefined : sourceFilter,
			hstatus: statusFilter === "all" ? undefined : statusFilter,
			hqueuedBy: queuedByFilter.trim() || undefined,
			hdevice: deviceFilter.trim() || undefined,
			herror: errorFilter.trim() || undefined,
			hcat: failureCategoryFilter.trim() || undefined,
		});
	});

	function matchesFilters(h: JobHistoryEntry): boolean {
		return (
			(!activeQuery ||
				h.bundleId.toLowerCase().includes(activeQuery.toLowerCase())) &&
			(sourceFilter === "all" || h.source === sourceFilter) &&
			(statusFilter === "all" || h.status === statusFilter) &&
			(!queuedByFilter.trim() ||
				(h.queuedBy ?? "")
					.toLowerCase()
					.includes(queuedByFilter.trim().toLowerCase())) &&
			(!deviceFilter.trim() ||
				(h.deviceId ?? "")
					.toLowerCase()
					.includes(deviceFilter.trim().toLowerCase())) &&
			(!errorFilter.trim() ||
				(h.error ?? "")
					.toLowerCase()
					.includes(errorFilter.trim().toLowerCase())) &&
			(!failureCategoryFilter.trim() ||
				(h.status === "failed" &&
					categorizeFailure(h.error) ===
						failureCategoryFilter.trim()))
		);
	}

	async function loadInitial(query: string): Promise<void> {
		loaded = false;
		selected = new Set();
		const data = await fetchJobHistory(
			0,
			PAGE_SIZE,
			query || undefined,
			sourceFilter === "all" ? undefined : sourceFilter,
			statusFilter === "all" ? undefined : statusFilter,
			{
				queuedBy: queuedByFilter.trim() || undefined,
				deviceId: deviceFilter.trim() || undefined,
				errorQ: errorFilter.trim() || undefined,
				failureCategory: failureCategoryFilter.trim() || undefined,
			},
		);
		entries = data.history;
		total = data.total;
		seenIds = new Set(entries.map((e) => e.id));
		void ensureAppCatalog(entries.map((entry) => entry.bundleId));
		loaded = true;
	}

	async function loadMore(): Promise<void> {
		loadingMore = true;
		try {
			const data = await fetchJobHistory(
				entries.length,
				PAGE_SIZE,
				activeQuery || undefined,
				sourceFilter === "all" ? undefined : sourceFilter,
				statusFilter === "all" ? undefined : statusFilter,
				{
					queuedBy: queuedByFilter.trim() || undefined,
					deviceId: deviceFilter.trim() || undefined,
					errorQ: errorFilter.trim() || undefined,
					failureCategory: failureCategoryFilter.trim() || undefined,
				},
			);
			const additions = data.history.filter((e) => !seenIds.has(e.id));
			for (const e of additions) seenIds.add(e.id);
			entries = [...entries, ...additions];
			total = data.total;
			void ensureAppCatalog(data.history.map((entry) => entry.bundleId));
		} finally {
			loadingMore = false;
		}
	}

	const debouncedSearch = debounce((query: string) => {
		activeQuery = query;
		void loadInitial(query);
	}, 300);

	$effect(() => {
		if (historyJumpState.bundleId) {
			searchText = historyJumpState.bundleId;
			sourceFilter = "all";
			statusFilter = "all";
			historyJumpState.bundleId = null;
		}
	});

	$effect(() => {
		if (historyJumpState.failureCategory) {
			failureCategoryFilter = historyJumpState.failureCategory;
			statusFilter = "failed";
			historyJumpState.failureCategory = null;
		}
	});

	let hasSearched = false;

	$effect(() => {
		const query = searchText.trim();
		sourceFilter;
		statusFilter;
		queuedByFilter;
		deviceFilter;
		errorFilter;
		failureCategoryFilter;
		if (!hasSearched) {
			hasSearched = true;
			activeQuery = query;
			void loadInitial(query);
		} else {
			debouncedSearch(query);
		}
	});

	$effect(() => {
		localStorage.setItem("jobHistorySearchText", searchText);
	});
	$effect(() => {
		localStorage.setItem("jobHistorySourceFilter", sourceFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryStatusFilter", statusFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryQueuedByFilter", queuedByFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryDeviceFilter", deviceFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryErrorFilter", errorFilter);
	});
	$effect(() => {
		localStorage.setItem(
			"jobHistoryFailureCategoryFilter",
			failureCategoryFilter,
		);
	});

	function clearSearch(): void {
		searchText = "";
	}

	const hasActiveFilters = $derived(
		!!(
			activeQuery ||
			sourceFilter !== "all" ||
			statusFilter !== "all" ||
			queuedByFilter ||
			deviceFilter ||
			errorFilter ||
			failureCategoryFilter
		),
	);
	const advancedFilterCount = $derived(
		[
			queuedByFilter,
			deviceFilter,
			errorFilter,
			failureCategoryFilter,
		].filter((value) => value.trim()).length,
	);

	function clearAllFilters(): void {
		searchText = "";
		sourceFilter = "all";
		statusFilter = "all";
		queuedByFilter = "";
		deviceFilter = "";
		errorFilter = "";
		failureCategoryFilter = "";
	}

	$effect(() => {
		for (const h of liveState.historyAdditions) {
			if (!seenIds.has(h.id) && matchesFilters(h)) {
				entries = [h, ...entries];
				seenIds.add(h.id);
				total += 1;
			}
		}
		void ensureAppCatalog(
			liveState.historyAdditions.map((entry) => entry.bundleId),
		);
	});

	let shareOpen = $state(false);
	let shareJobId = $state("");

	function openShare(id: string): void {
		shareJobId = id;
		shareOpen = true;
	}

	let statsOpen = $state(false);
	let statsBundleId = $state("");
	let statsPreselectIds = $state<string[] | undefined>(undefined);

	function openStats(bundleId: string): void {
		statsBundleId = bundleId;
		statsPreselectIds = undefined;
		statsOpen = true;
	}

	const compareCandidate = $derived.by(() => {
		if (selected.size !== 2) return null;
		const rows = entries.filter((e) => selected.has(e.id));
		if (
			rows.length !== 2 ||
			rows[0].bundleId !== rows[1].bundleId ||
			rows.some((r) => r.status !== "done")
		)
			return null;
		return { bundleId: rows[0].bundleId, ids: rows.map((r) => r.id) };
	});

	function openCompare(): void {
		if (!compareCandidate) return;
		statsBundleId = compareCandidate.bundleId;
		statsPreselectIds = compareCandidate.ids;
		statsOpen = true;
	}

	function curlFor(entry: JobHistoryEntry): string {
		const base = sessionState.publicBaseUrl ?? location.origin;
		const versionQuery = entry.externalVersionId
			? `&externalVersionId=${entry.externalVersionId}`
			: "";
		return `curl -H "Authorization: Bearer <YOUR_API_KEY>" "${base}/v1/decrypt?bundleId=${entry.bundleId}${versionQuery}" -o ${entry.bundleId}.ipa`;
	}

	async function decryptAgain(entry: JobHistoryEntry): Promise<void> {
		const { bundleId, testflight, externalVersionId, versionLabel } = entry;
		requeueing = new Set(requeueing).add(entry.id);
		try {
			const { ok, data } = testflight
				? await queueTestFlightDecrypt(
						bundleId,
						testflight.appId,
						testflight.build,
					)
				: await queueDecrypt(bundleId, externalVersionId, versionLabel);
			if (!ok) return;
			addDecrypt({
				id: data.id,
				bundleId,
				trackName: appDisplayName(bundleId),
				versionLabel,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
			});
			pushRecentBundleId(bundleId);
			showToast(
				`Queued ${appDisplayName(bundleId)}${versionLabel ? ` (${versionLabel})` : ""}`,
				"success",
			);
		} finally {
			const next = new Set(requeueing);
			next.delete(entry.id);
			requeueing = next;
		}
	}

	async function retryOnPrimary(entry: JobHistoryEntry): Promise<void> {
		requeueing = new Set(requeueing).add(entry.id);
		try {
			const { ok, data } = await retryJob(entry.id, true);
			if (!ok) return;
			addDecrypt({
				id: data.id,
				bundleId: entry.bundleId,
				trackName: appDisplayName(entry.bundleId),
				versionLabel: entry.versionLabel,
				externalVersionId: entry.externalVersionId,
				testflight: entry.testflight,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
			});
			pushRecentBundleId(entry.bundleId);
			showToast(
				`Retried ${appDisplayName(entry.bundleId)} on primary device`,
				"success",
			);
		} finally {
			const next = new Set(requeueing);
			next.delete(entry.id);
			requeueing = next;
		}
	}

	function openJobDetails(entry: JobHistoryEntry): void {
		jobDetailsId = entry.id;
		jobDetailsTitle = entry.versionLabel
			? `${appDisplayName(entry.bundleId)} (${entry.versionLabel})`
			: appDisplayName(entry.bundleId);
		jobDetailsOpen = true;
		setQueryParams({ job: entry.id });
	}

	$effect(() => {
		if (!jobDetailsId || jobDetailsTitle) return;
		const entry = entries.find((item) => item.id === jobDetailsId);
		if (entry) openJobDetails(entry);
	});

	$effect(() => {
		if (!jobDetailsOpen && getQueryParam("job")) setQueryParams({ job: undefined });
	});

	function toggleSelect(id: string): void {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function toggleSelectAll(): void {
		selected =
			selected.size === entries.length
				? new Set()
				: new Set(entries.map((e) => e.id));
	}

	async function openBulkPreview(): Promise<void> {
		const ids = entries.filter((entry) => selected.has(entry.id)).map((entry) => entry.id);
		if (ids.length === 0) return;
		bulkPreviewLoading = true;
		try {
			bulkPreview = await previewBulkJobReplay(ids);
			bulkPreviewOpen = true;
		} catch {
			showToast("Could not prepare the bulk preview", "error");
		} finally {
			bulkPreviewLoading = false;
		}
	}

	async function confirmBulkDecryptAgain(): Promise<void> {
		const targets = entries.filter((entry) => bulkPreview?.items.some((item) => item.id === entry.id && item.action === "queue"));
		bulkPreviewOpen = false;
		if (targets.length === 0) return;
		bulkRequeueing = true;
		try {
			for (const entry of targets) await decryptAgain(entry);
			selected = new Set();
			bulkPreview = null;
		} finally {
			bulkRequeueing = false;
		}
	}

	function bulkExportCsv(): void {
		const targets = entries.filter((e) => selected.has(e.id));
		const rows = [
			"bundleId,version,source,queuedBy,status,size,finishedAt,error",
		];
		for (const j of targets) {
			rows.push(
				[
					j.bundleId,
					j.versionLabel ?? "",
					j.source,
					j.queuedBy ?? "",
					j.status,
					j.sizeBytes ?? "",
					new Date(j.finishedAt).toISOString(),
					j.error ?? "",
				]
					.map(csvCell)
					.join(","),
			);
		}
		downloadBlob(
			rows.join("\n"),
			"dkrypt-job-history-selected.csv",
			"text/csv",
		);
	}

	function bulkExportJson(): void {
		const targets = entries.filter((e) => selected.has(e.id));
		downloadBlob(
			JSON.stringify(targets, null, 2),
			"dkrypt-job-history-selected.json",
			"application/json",
		);
	}

	function dayLabel(ms: number): string {
		const d = new Date(ms);
		const today = new Date();
		const startOfDay = (x: Date) =>
			new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
		const diffDays = Math.round(
			(startOfDay(today) - startOfDay(d)) / 86_400_000,
		);
		if (diffDays === 0) return "Today";
		if (diffDays === 1) return "Yesterday";
		return d.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year:
				d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
		});
	}

	const grouped = $derived.by(
		(): { label: string; items: JobHistoryEntry[] }[] => {
			const groups: { label: string; items: JobHistoryEntry[] }[] = [];
			for (const e of entries) {
				const label = dayLabel(e.finishedAt);
				const last = groups[groups.length - 1];
				if (last && last.label === label) last.items.push(e);
				else groups.push({ label, items: [e] });
			}
			return groups;
		},
	);
</script>

<Card title="Job history" id="job-history">
	{#snippet headerExtra()}
		<div class="flex flex-wrap items-center gap-1.5">
			{#if selected.size > 0}
				{#if compareCandidate}
					<Button size="sm" variant="secondary" onclick={openCompare}
						>Compare selected</Button
					>
				{/if}
				<Button
					size="sm"
					loading={bulkRequeueing || bulkPreviewLoading}
					onclick={() => void openBulkPreview()}
					>Decrypt {selected.size} again</Button
				>
				<Button size="sm" variant="secondary" onclick={bulkExportCsv}
					>Export {selected.size} CSV</Button
				>
				<Button size="sm" variant="secondary" onclick={bulkExportJson}
					>Export {selected.size} JSON</Button
				>
			{/if}
			<a
				href={jobHistoryExportUrl("csv")}
				download
				class={buttonVariants("secondary", "sm")}>Export CSV</a
			>
			<a
				href={jobHistoryExportUrl("json")}
				download
				class={buttonVariants("secondary", "sm")}>Export JSON</a
			>
		</div>
	{/snippet}
	{#if entries.length > 0}
		<label class="mb-3 inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
			<input
				type="checkbox"
				checked={selected.size === entries.length}
				onchange={toggleSelectAll}
				aria-label="Select or unselect all loaded jobs"
			/>
			Select all loaded
		</label>
	{/if}
	<div class="mb-3 flex flex-wrap items-center gap-2.5">
		<div class="relative max-w-xs flex-1">
			<Input
				placeholder="Search apps or bundle IDs…"
				bind:value={searchText}
				class="pr-8"
			/>
			{#if searchText}
				<button
					class="text-muted hover:text-text absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer"
					onclick={clearSearch}
					aria-label="Clear search"
					title="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
		<div class="flex flex-wrap gap-1">
			<Button
				variant={statusFilter === "all" ? "default" : "secondary"}
				onclick={() => (statusFilter = "all")}>All</Button
			>
			<Button
				variant={statusFilter === "done" ? "default" : "secondary"}
				onclick={() => (statusFilter = "done")}>Done</Button
			>
			<Button
				variant={statusFilter === "failed" ? "default" : "secondary"}
				onclick={() => (statusFilter = "failed")}>Failed</Button
			>
		</div>
		<div class="flex flex-wrap gap-1">
			<Button
				variant={sourceFilter === "all" ? "default" : "secondary"}
				onclick={() => (sourceFilter = "all")}>Any source</Button
			>
			<Button
				variant={sourceFilter === "manual" ? "default" : "secondary"}
				onclick={() => (sourceFilter = "manual")}>Manual</Button
			>
			<Button
				variant={sourceFilter === "scheduler" ? "default" : "secondary"}
				onclick={() => (sourceFilter = "scheduler")}
			>
				Scheduler
			</Button>
		</div>
	</div>

	<details class="border-border mb-3 rounded-lg border">
		<summary
			class="text-muted cursor-pointer px-3 py-2 text-xs font-medium"
		>
			More filters and saved views{advancedFilterCount
				? ` · ${advancedFilterCount} active`
				: ""}
		</summary>
		<div
			class="border-border grid grid-cols-1 gap-2 border-t p-3 sm:grid-cols-3"
		>
			<Input
				placeholder="Queued by username…"
				bind:value={queuedByFilter}
			/>
			<Input placeholder="Device id…" bind:value={deviceFilter} />
			<Input placeholder="Error contains…" bind:value={errorFilter} />
		</div>
		<div
			class="border-border flex flex-wrap items-center gap-1.5 border-t p-3"
		>
			{#if failureCategoryFilter}
				<span
					class="border-accent text-accent inline-flex items-center gap-1.5 rounded-full border pr-1 pl-2.5 py-1 text-[12px]"
				>
					Failure category: {failureCategoryFilter}
					<button
						class="hover:text-err cursor-pointer rounded-full p-0.5"
						onclick={() => (failureCategoryFilter = "")}
						aria-label="Clear failure category filter"
						title="Clear failure category filter"
					>
						<X class="h-3 w-3" />
					</button>
				</span>
			{/if}
			{#each savedViews.presets as p (p.name)}
				<span
					class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-2.5 py-1 text-[12px]"
				>
					<button
						class="cursor-pointer"
						onclick={() => applyPreset(p)}>{p.name}</button
					>
					<button
						class="text-muted hover:text-err cursor-pointer rounded-full p-0.5"
						onclick={() => removePreset(p.name)}
						aria-label="Delete preset {p.name}"
						title="Delete preset"
					>
						<X class="h-3 w-3" />
					</button>
				</span>
			{/each}
			<div class="flex items-center gap-1.5">
				<Input
					placeholder="Preset name…"
					bind:value={newPresetName}
					class="h-7 w-32 text-xs"
				/>
				<Button
					size="sm"
					variant="secondary"
					disabled={!newPresetName.trim()}
					onclick={savePreset}>Save view</Button
				>
			</div>
		</div>
	</details>

	{#if loaded && entries.length === 0}
		<EmptyState
			icon={History}
			message={hasActiveFilters
				? "No decrypts match these filters."
				: "No decrypts yet."}
		>
			{#snippet action()}
				{#if hasActiveFilters}
					<Button
						size="sm"
						variant="secondary"
						onclick={clearAllFilters}>Clear filters</Button
					>
				{:else}
					<Button
						size="sm"
						variant="secondary"
						onclick={requestFocusSearch}>Queue a decrypt</Button
					>
				{/if}
			{/snippet}
		</EmptyState>
	{:else}
		<div class="history-feed">
			{#if !loaded}
				{#each Array(5) as _, i (i)}
					<div
						class="skeleton border-border h-20 border-b"
						aria-label="Loading job history"
					></div>
				{/each}
			{:else}
				{#each grouped as g (g.label)}
					<section class="mb-5">
						<div
							class="border-border mb-1 flex items-center gap-2 border-b pb-2"
						>
							<span
								class="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase"
								>{g.label}</span
							>
							<span class="text-[11px] text-muted"
								>{g.items.length} job{g.items.length === 1
									? ""
									: "s"}</span
							>
						</div>
						<div role="list">
							{#each g.items as j (j.id)}
								<article
									class="history-feed-row"
									role="listitem"
								>
									<div
										class="history-feed-summary flex min-w-0 flex-1 items-start gap-3"
									>
										<input
											class="mt-1"
											type="checkbox"
											checked={selected.has(j.id)}
											onchange={() => toggleSelect(j.id)}
											aria-label="Select {j.bundleId}"
										/>
										<div class="min-w-0 flex-1">
											<div
												class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
											>
											<AppIcon bundleId={j.bundleId} src={appIconUrl(j.bundleId)} label={appDisplayName(j.bundleId)} class="h-5 w-5" />
												<button
													class="max-w-full cursor-pointer truncate text-[12.5px] font-medium hover:text-accent hover:underline"
													title="View stats for {appDisplayName(
														j.bundleId,
													)}"
													onclick={() =>
														openStats(j.bundleId)}
												>
													{appDisplayName(j.bundleId)}
												</button>
												{#if j.testflight}
													<Badge variant="secondary"
														>TestFlight</Badge
													>
												{/if}
											<span class="text-xs text-muted"
												>{j.source}</span
											>
											<span class="text-xs text-muted" title="The dashboard user or API-key owner that queued this job">
												requested by {j.queuedBy ?? (j.source === "scheduler" ? "scheduler" : "unknown")}
											</span>
										</div>
											<div
												class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
												title={j.bundleId}
											>
												<span
											>{j.versionLabel ??
													"Current App Store release"}</span
												>
												<span
													>{fmtSize(
														j.sizeBytes,
													)}</span
												>
											</div>
										</div>
									</div>
									<div
										class="history-feed-status w-full shrink-0 self-start sm:w-[11.5rem]"
									>
										<div class="flex items-center gap-2">
											<Badge
												variant={statusToBadgeVariant(
													j.status,
												)}>{j.status}</Badge
											>
											<span class="text-xs text-muted"
												><RelativeTime
													ms={j.finishedAt}
												/></span
											>
										</div>
									</div>
									<div
										class="history-feed-actions flex w-full shrink-0 items-center justify-start gap-1.5 self-start sm:w-[15rem] sm:justify-end"
									>
										{#if j.status === "failed"}
											{#if j.activeShareUrl}
												<a class={buttonVariants("default", "sm")} href={j.activeShareUrl}>Download</a>
											{/if}
											<Button size="sm" variant="secondary" onclick={() => openJobDetails(j)} title="Inspect job"><Eye class="h-3.5 w-3.5" /></Button>
											<Button
												size="sm"
												loading={requeueing.has(j.id)}
												onclick={() =>
													retryOnPrimary(j)}
												>Retry</Button
											>
										{:else}
											{#if j.activeShareUrl}
												<a class={buttonVariants("default", "sm")} href={j.activeShareUrl}>Download</a>
											{/if}
											<Button size="sm" variant="secondary" onclick={() => openJobDetails(j)} title="Inspect job"><Eye class="h-3.5 w-3.5" /></Button>
											<Button
												size="sm"
												variant="secondary"
												loading={requeueing.has(j.id)}
												onclick={() => decryptAgain(j)}
												>Decrypt again</Button
											>
										{/if}
										{#if j.status === "done" && j.fileAvailable && !j.activeShareUrl}
											<Button
												size="sm"
												variant="secondary"
												onclick={() => openShare(j.id)}
												>Download</Button
											>
										{/if}
										{#if !j.testflight}
											<CopyButton
												text={curlFor(j)}
												label="curl"
											/>
										{/if}
									</div>
								</article>
							{/each}
						</div>
					</section>
				{/each}
			{/if}
		</div>
	{/if}
	{#if loaded && entries.length < total}
		<div class="mt-3 flex justify-center">
			<Button
				size="sm"
				variant="secondary"
				loading={loadingMore}
				onclick={loadMore}
			>
				Load more ({total - entries.length} older)
			</Button>
		</div>
	{/if}
</Card>

<ShareLinkDialog
	open={shareOpen}
	jobId={shareJobId}
	onOpenChange={(v) => (shareOpen = v)}
/>
<BundleStatsDialog
	open={statsOpen}
	bundleId={statsBundleId}
	preselectIds={statsPreselectIds}
	onOpenChange={(v) => (statsOpen = v)}
/>
<JobDetailsDialog bind:open={jobDetailsOpen} jobId={jobDetailsId} title={jobDetailsTitle || "Job details"} />
<BulkJobPreviewDialog
	open={bulkPreviewOpen}
	preview={bulkPreview}
	onOpenChange={(v) => {
		bulkPreviewOpen = v;
		if (!v) bulkPreview = null;
	}}
	onConfirm={() => void confirmBulkDecryptAgain()}
/>
