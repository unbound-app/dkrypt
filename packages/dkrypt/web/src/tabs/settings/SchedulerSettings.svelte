<script lang="ts">
	import {
		CircleCheck,
		LoaderCircle,
		Plus,
		Search,
		TriangleAlert,
		X,
	} from "lucide-svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import AppIcon from "#components/AppIcon.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import {
		createWatch,
		deleteWatch,
		fetchSettings,
		fetchWebhookDeliveries,
		fetchGithubRepos,
		fetchGithubRateLimit,
		fetchGitHubBudgetTelemetry,
		fetchGithubWorkflows,
		fetchAppCatalogStats,
		importWatches,
		fetchTestFlightBridgeDiagnostics,
		fetchWatchHealth,
		previewWatchDispatchSource,
		previewWatchDispatchDraft,
		validateWatchDispatchDraft,
		saveSettings,
		searchApps,
		testWebhook,
		triggerWatchDispatch,
		updateWatch,
		watchesExportUrl,
		validateCron,
		type AppWatch,
		type AppCatalogStats,
		type AppStoreSearchResult,
		type DispatchTarget,
		type DispatchValidationResult,
		type GithubRepoOption,
		type GithubRateLimit,
		type GitHubBudgetTelemetryEntry,
		type GithubWorkflowOption,
		type SchedulerSettings,
		type TestFlightUpdateCheck,
		type TestFlightBridgeDiagnostics,
		type UpdateCheck,
		type WatchInput,
		type WatchHealthSummary,
		type WebhookDeliveryEntry,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import Select from "#lib/components/ui/Select.svelte";
	import SearchSelect from "#lib/components/ui/SearchSelect.svelte";
	import Switch from "#lib/components/ui/Switch.svelte";
	import { buttonVariants } from "#lib/components/ui/variants";
	import { debounce } from "#lib/format";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
		primeAppCatalogFromSearch,
		refreshAppCatalog,
	} from "#lib/appCatalog.svelte";
	import { liveState } from "#lib/live.svelte";
	import { PermissionFlag } from "#lib/permissions";
	import { sessionHasPermission } from "#lib/session.svelte";
	import { confirmDialog, showToast } from "#lib/ui.svelte";
	import { exampleWebhookPayload } from "#lib/webhookExamples";
	import Popover from "#lib/components/ui/Popover.svelte";
	import CopyButton from "#components/CopyButton.svelte";

	const FORMAT_OPTIONS = [
		{ value: "embed", label: "Rich embed (Discord)" },
		{ value: "plain", label: "Plain text (Slack / generic)" },
	];

	const SUCCESS_DELIVERY_OPTIONS = [
		{ value: "instant", label: "Immediately" },
		{ value: "daily", label: "Daily digest (09:00)" },
		{ value: "weekly", label: "Weekly digest (Monday 09:00)" },
	];

	const TESTFLIGHT_POLICY_OPTIONS = [
		{ value: "latest", label: "Latest build" },
		{ value: "latestNonExpired", label: "Latest non-expired build" },
		{ value: "train", label: "Specific train" },
	];

	const NOTIFY_EVENTS: {
		key: keyof SchedulerSettings;
		label: string;
		description: string;
		group: "Automation" | "Access" | "Device" | "Capacity";
	}[] = [
		{
			key: "notifyOnJobCompleted",
			label: "Any decrypt finishes",
			group: "Automation",
			description:
				"Manual or scheduler jobs, including App Store and TestFlight paths",
		},
		{
			key: "notifyOnKeyRequest",
			label: "API key requests",
			group: "Access",
			description: "A user without approveApiKeys requests a new key",
		},
		{
			key: "notifyOnAutomationSuccess",
			label: "Automation succeeded",
			group: "Automation",
			description:
				"A watched App Store or TestFlight release completed its GitHub workflow",
		},
		{
			key: "notifyOnAutomationFailure",
			label: "Automation needs attention",
			group: "Automation",
			description:
				"A watched App Store or TestFlight release failed a check, decrypt, dispatch, or workflow",
		},
		{
			key: "notifyOnKeyExpiringSoon",
			label: "API key expiring soon",
			group: "Access",
			description:
				"An approved key has 7 days or less left before it expires",
		},
		{
			key: "notifyOnDeviceOffline",
			label: "iDevice unreachable",
			group: "Device",
			description:
				"A device stays unreachable past the alert threshold below",
		},
		{
			key: "notifyOnDeviceBatteryHot",
			label: "iDevice battery hot",
			group: "Device",
			description:
				"Battery temperature reaches the alert threshold below",
		},
		{
			key: "notifyOnDeviceBatteryLow",
			label: "iDevice battery low",
			group: "Device",
			description:
				"Battery drops to the alert threshold below while not charging",
		},
		{
			key: "notifyOnDiskFull",
			label: "Staging disk full",
			group: "Capacity",
			description:
				"The host staging disk (OUTPUT_DIR) reaches the alert threshold below",
		},
		{
			key: "notifyOnDeviceStorageLow",
			label: "iDevice storage low",
			group: "Capacity",
			description:
				"A device's own storage reaches the alert threshold below",
		},
		{
			key: "notifyOnTestFlightBridgeDown",
			label: "autoinstall bridge unresponsive",
			group: "Device",
			description:
				"The autoinstall SpringBoard bridge stops responding past the alert threshold below",
		},
	];

	const RETRY_OPTIONS = [
		{ value: "0", label: "Off (no retry)" },
		{ value: "1", label: "1 retry" },
		{ value: "2", label: "2 retries" },
		{ value: "3", label: "3 retries" },
		{ value: "5", label: "5 retries" },
	];

	const OFFLINE_ALERT_OPTIONS = [
		{ value: "5", label: "5 minutes" },
		{ value: "15", label: "15 minutes" },
		{ value: "30", label: "30 minutes" },
		{ value: "60", label: "1 hour" },
		{ value: "180", label: "3 hours" },
	];

	const BATTERY_HOT_ALERT_OPTIONS = [
		{ value: "40", label: "40°C" },
		{ value: "42", label: "42°C" },
		{ value: "45", label: "45°C" },
		{ value: "48", label: "48°C" },
		{ value: "50", label: "50°C" },
	];

	const BATTERY_LOW_ALERT_OPTIONS = [
		{ value: "5", label: "5%" },
		{ value: "10", label: "10%" },
		{ value: "15", label: "15%" },
		{ value: "20", label: "20%" },
		{ value: "30", label: "30%" },
	];

	const STORAGE_ALERT_OPTIONS = [
		{ value: "75", label: "75%" },
		{ value: "80", label: "80%" },
		{ value: "90", label: "90%" },
		{ value: "95", label: "95%" },
		{ value: "99", label: "99%" },
	];

	const TESTFLIGHT_BRIDGE_ALERT_OPTIONS = [
		{ value: "5", label: "5 minutes" },
		{ value: "15", label: "15 minutes" },
		{ value: "30", label: "30 minutes" },
		{ value: "60", label: "1 hour" },
		{ value: "180", label: "3 hours" },
	];

	const RETENTION_OPTIONS = [
		{ value: "0", label: "Keep forever (up to 100 entries)" },
		{ value: "30", label: "30 days" },
		{ value: "90", label: "90 days" },
		{ value: "180", label: "180 days" },
		{ value: "365", label: "365 days" },
	];

	const CRON_PRESETS: { label: string; expr: string }[] = [
		{ label: "Every 15 min", expr: "*/15 * * * *" },
		{ label: "Every 30 min", expr: "*/30 * * * *" },
		{ label: "Hourly", expr: "0 * * * *" },
		{ label: "Every 6 hours", expr: "0 */6 * * *" },
		{ label: "Daily at 3am", expr: "0 3 * * *" },
	];

	const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
	const WEBHOOK_URL_RE = /^https?:\/\/.+/;
	const DISPATCH_MODE_OPTIONS = [
		{ value: "repository_dispatch", label: "Repository dispatch" },
		{ value: "workflow_dispatch", label: "Workflow dispatch" },
	];

	function workflowFileName(path: string): string {
		const idx = path.lastIndexOf("/");
		return idx >= 0 ? path.slice(idx + 1) : path;
	}

	const canManageWatches = $derived(
		sessionHasPermission(PermissionFlag.manageAutomation),
	);
	const canManageSchedulerSettings = $derived(
		sessionHasPermission(PermissionFlag.manageAutomation),
	);
	const canTriggerDispatch = $derived(
		sessionHasPermission(PermissionFlag.manageAutomation),
	);

	const DEFAULT_WATCH_FORM: WatchInput = {
		bundleId: "",
		repo: "",
		ghWorkflowFile: "remote-ipa-update.yml",
		dispatchTargets: [{ repo: "", ghWorkflowFile: "remote-ipa-update.yml" }],
		pollCron: "0 * * * *",
		enabled: true,
		webhookUrl: "",
		testFlightPolicy: "latest",
		testFlightTrain: "",
	};

	let watchDialogOpen = $state(false);
	let editingWatchId = $state<string | null>(null);
	let watchForm = $state<WatchInput>({ ...DEFAULT_WATCH_FORM });
	let dispatchTargets = $state<DispatchTarget[]>([...(DEFAULT_WATCH_FORM.dispatchTargets ?? [])]);
	let watchCronValid = $state<boolean | null>(null);
	let savingWatch = $state(false);
	let previewByWatch = $state<Record<string, UpdateCheck | null>>({});
	let previewingWatch = $state<Set<string>>(new Set());
	let previewProgressByWatch = $state<Record<string, PreviewProgress[]>>({});
	let triggeringWatch = $state<Set<string>>(new Set());
	let deletingWatch = $state<Set<string>>(new Set());
	let loadingBridgeDiagnostics = $state(false);
	let bridgeDiagnostics = $state<TestFlightBridgeDiagnostics | null>(null);
	let bridgeDiagnosticsOpen = $state(false);
	let watchHealth = $state<WatchHealthSummary[]>([]);
	let watchSearchTerm = $state("");
	let watchSearchResults = $state<AppStoreSearchResult[]>([]);
	let watchSearchLoading = $state(false);
	let watchSearchSearched = $state(false);
	let watchSearchToken = 0;
	let githubRepos = $state<GithubRepoOption[]>([]);
	let githubRateLimit = $state<GithubRateLimit | null>(null);
	let githubReposError = $state("");
	let githubWorkflowsByRepo = $state<Record<string, GithubWorkflowOption[]>>({});
	let githubWorkflowErrors = $state<Record<string, string>>({});
	let loadingWorkflowRepos = $state<Set<string>>(new Set());
	let importingWatches = $state(false);
	let watchImportInput = $state<HTMLInputElement | null>(null);
	let appCatalogStats = $state<AppCatalogStats | null>(null);
	let refreshingCatalog = $state(false);
	let githubBudgetTelemetry = $state<GitHubBudgetTelemetryEntry[]>([]);

	const watches = $derived(liveState.overview?.watches ?? []);
	const failedWatchCount = $derived(watchHealth.filter((watch) => watch.lastCheckOk === false || watch.consecutiveFailures > 0).length);
	const healthyWatchCount = $derived(watchHealth.filter((watch) => watch.lastCheckOk && watch.consecutiveFailures === 0).length);

	function healthForWatch(watchId: string): WatchHealthSummary | undefined {
		return watchHealth.find((entry) => entry.watchId === watchId);
	}

	$effect(() => {
		void ensureAppCatalog(watches.map((watch) => watch.bundleId));
	});

	$effect(() => {
		if (!canManageWatches) return;
		void fetchGithubRateLimit().then((limit) => (githubRateLimit = limit)).catch(() => undefined);
	});

	$effect(() => {
		void fetchAppCatalogStats().then((stats) => (appCatalogStats = stats)).catch(() => undefined);
	});

	$effect(() => {
		const load = () => void fetchWatchHealth().then(({ watches: next }) => (watchHealth = next)).catch(() => undefined);
		load();
		const interval = setInterval(load, 30_000);
		return () => clearInterval(interval);
	});

	$effect(() => {
		if (!canManageWatches) return;
		const load = () => void fetchGitHubBudgetTelemetry().then(({ entries }) => (githubBudgetTelemetry = entries)).catch(() => undefined);
		load();
		const interval = setInterval(load, 60_000);
		return () => clearInterval(interval);
	});

	async function openBridgeDiagnostics(): Promise<void> {
		loadingBridgeDiagnostics = true;
		bridgeDiagnosticsOpen = true;
		try {
			bridgeDiagnostics = await fetchTestFlightBridgeDiagnostics();
		} catch (err) {
			bridgeDiagnostics = null;
			showToast(err instanceof Error ? err.message : "Could not load bridge diagnostics", "error");
		} finally {
			loadingBridgeDiagnostics = false;
		}
	}

	const checkWatchCron = debounce(async (expr: string) => {
		if (!expr) {
			watchCronValid = null;
			return;
		}
		const { valid } = await validateCron(expr);
		watchCronValid = valid;
	}, 400);

	$effect(() => {
		checkWatchCron(watchForm.pollCron);
	});

	$effect(() => {
		if (canManageWatches) void loadGithubRepos();
	});

	function repoItemsFor(current: string) {
		const options = githubRepos.map((repo) => ({
			value: repo.fullName,
			label: `${repo.fullName}${repo.isPrivate ? " (private)" : ""}`,
		}));
		const selected = current.trim();
		if (selected && !options.some((option) => option.value === selected)) {
			options.unshift({
				value: selected,
				label: `${selected} (current)`,
			});
		}
		return options;
	}

	function workflowItemsFor(repo: string, current: string) {
		const options = (githubWorkflowsByRepo[repo] ?? []).map((workflow) => ({
			value: workflowFileName(workflow.path),
			label: `${workflow.name} (${workflowFileName(workflow.path)})`,
		}));
		const selected = current.trim();
		if (selected && !options.some((option) => option.value === selected)) {
			options.unshift({
				value: selected,
				label: `${selected} (current)`,
			});
		}
		return options;
	}

	const watchRepoErrors = $derived({
		repo:
			watchForm.repo && !REPO_RE.test(watchForm.repo)
				? "Expected owner/repo"
				: "",
		webhookUrl:
			watchForm.webhookUrl && !WEBHOOK_URL_RE.test(watchForm.webhookUrl)
				? "Expected a full http(s):// URL"
				: "",
	});

	function openAddWatch(): void {
		editingWatchId = null;
		watchForm = { ...DEFAULT_WATCH_FORM };
		watchSearchTerm = "";
		watchSearchResults = [];
		watchSearchSearched = false;
		watchSearchLoading = false;
		watchSearchToken += 1;
		dispatchTargets = [{ repo: "", ghWorkflowFile: "remote-ipa-update.yml" }];
		draftPreview = null;
		watchDialogOpen = true;
	}

	function openEditWatch(w: AppWatch): void {
		editingWatchId = w.id;
		watchForm = {
			bundleId: w.bundleId,
			repo: w.repo,
			ghWorkflowFile: w.ghWorkflowFile,
			pollCron: w.pollCron,
			enabled: w.enabled,
			webhookUrl: w.webhookUrl ?? "",
			testFlightPolicy: w.testFlightPolicy ?? "latest",
			testFlightTrain: w.testFlightTrain ?? "",
		};
		dispatchTargets = w.dispatchTargets?.length
			? w.dispatchTargets.map((target) => ({ ...target }))
			: [{ repo: w.repo, ghWorkflowFile: w.ghWorkflowFile }];
		watchSearchTerm = appDisplayName(w.bundleId);
		watchSearchResults = [];
		watchSearchSearched = false;
		watchSearchLoading = false;
		watchSearchToken += 1;
		for (const target of dispatchTargets) void loadGithubWorkflows(target.repo);
		draftPreview = null;
		watchDialogOpen = true;
	}

	async function loadGithubRepos(): Promise<void> {
		if (githubRepos.length > 0) return;
		githubReposError = "";
		try {
			const { repos } = await fetchGithubRepos();
			githubRepos = repos;
		} catch (err) {
			githubRepos = [];
			githubReposError =
				err instanceof Error
					? err.message
					: "Failed to load GitHub repositories";
		}
	}

	async function loadGithubWorkflows(repo: string): Promise<void> {
		const trimmed = repo.trim();
		if (!trimmed || !REPO_RE.test(trimmed) || githubWorkflowsByRepo[trimmed] || loadingWorkflowRepos.has(trimmed)) return;
		loadingWorkflowRepos = new Set(loadingWorkflowRepos).add(trimmed);
		githubWorkflowErrors = { ...githubWorkflowErrors, [trimmed]: "" };
		try {
			const { workflows } = await fetchGithubWorkflows(trimmed);
			githubWorkflowsByRepo = { ...githubWorkflowsByRepo, [trimmed]: workflows };
		} catch (err) {
			githubWorkflowErrors = { ...githubWorkflowErrors, [trimmed]: err instanceof Error ? err.message : "Failed to load workflows" };
		} finally {
			const next = new Set(loadingWorkflowRepos);
			next.delete(trimmed);
			loadingWorkflowRepos = next;
		}
	}

	function setDispatchTarget(index: number, patch: Partial<DispatchTarget>): void {
		dispatchTargets = dispatchTargets.map((target, targetIndex) => targetIndex === index ? { ...target, ...patch } : target);
		const primary = dispatchTargets[0] ?? { repo: "", ghWorkflowFile: "remote-ipa-update.yml" };
		watchForm = { ...watchForm, repo: primary.repo, ghWorkflowFile: primary.ghWorkflowFile, dispatchTargets };
	}

	function onWatchRepoChange(index: number, repo: string): void {
		setDispatchTarget(index, { repo });
		void loadGithubWorkflows(repo);
	}

	function onWatchWorkflowChange(index: number, ghWorkflowFile: string): void {
		setDispatchTarget(index, { ghWorkflowFile });
	}

	function setDispatchInput(index: number, previousKey: string, key: string, value: string): void {
		const inputs = { ...(dispatchTargets[index]?.inputs ?? {}) };
		delete inputs[previousKey];
		if (key.trim()) inputs[key.trim()] = value;
		setDispatchTarget(index, { inputs: Object.keys(inputs).length ? inputs : undefined });
	}

	function addDispatchInput(index: number): void {
		const inputs = { ...(dispatchTargets[index]?.inputs ?? {}) };
		let name = "input-name";
		let suffix = 2;
		while (name in inputs) name = `input-name-${suffix++}`;
		inputs[name] = "";
		setDispatchTarget(index, { inputs });
	}

	function addDispatchTarget(): void {
		dispatchTargets = [...dispatchTargets, { repo: "", ghWorkflowFile: "remote-ipa-update.yml" }];
	}

	function removeDispatchTarget(index: number): void {
		if (dispatchTargets.length === 1) return;
		dispatchTargets = dispatchTargets.filter((_, targetIndex) => targetIndex !== index);
		setDispatchTarget(0, {});
	}

	function pickWatchApp(result: AppStoreSearchResult): void {
		watchForm = { ...watchForm, bundleId: result.bundleId };
		watchSearchTerm = result.trackName;
		watchSearchResults = [];
		watchSearchSearched = false;
		primeAppCatalogFromSearch([result]);
	}

	async function runWatchSearch(q: string): Promise<void> {
		const trimmed = q.trim();
		const token = ++watchSearchToken;
		if (!trimmed) {
			watchSearchResults = [];
			watchSearchSearched = false;
			watchSearchLoading = false;
			return;
		}
		watchSearchLoading = true;
		try {
			const data = await searchApps(trimmed);
			if (token !== watchSearchToken) return;
			if ("error" in data) {
				watchSearchResults = [];
				showToast(data.error, "error");
			} else {
				watchSearchResults = data.results;
				primeAppCatalogFromSearch(data.results);
			}
			watchSearchSearched = true;
		} catch {
			if (token !== watchSearchToken) return;
			watchSearchResults = [];
			watchSearchSearched = true;
		} finally {
			if (token === watchSearchToken) watchSearchLoading = false;
		}
	}

	const debouncedWatchSearch = debounce(
		(q: string) => void runWatchSearch(q),
		400,
	);

	function onWatchSearchInput(): void {
		if (!watchSearchTerm.trim()) {
			debouncedWatchSearch.cancel();
			watchSearchToken += 1;
			watchSearchResults = [];
			watchSearchSearched = false;
			watchSearchLoading = false;
			return;
		}
		debouncedWatchSearch(watchSearchTerm);
	}

	function applyCronPreset(expr: string): void {
		watchForm = { ...watchForm, pollCron: expr };
	}

	let draftPreview = $state<UpdateCheck | null>(null);
	let previewingDraft = $state(false);
	let draftPreviewError = $state("");
	let validatingDraft = $state(false);
	let dispatchValidation = $state<DispatchValidationResult[] | null>(null);

	async function previewDraft(): Promise<void> {
		if (
			!watchForm.bundleId.trim() ||
			!watchForm.repo.trim() ||
			watchRepoErrors.repo
		)
			return;
		previewingDraft = true;
		draftPreviewError = "";
		try {
			draftPreview = await previewWatchDispatchDraft(
				watchForm.bundleId.trim(),
				watchForm.repo.trim(),
			);
		} catch (err) {
			draftPreview = null;
			draftPreviewError =
				err instanceof Error ? err.message : String(err);
		} finally {
			previewingDraft = false;
		}
	}

	async function validateDraftDispatch(): Promise<void> {
		if (dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim())) return;
		validatingDraft = true;
		dispatchValidation = null;
		try {
			dispatchValidation = (await validateWatchDispatchDraft(dispatchTargets)).results;
		} catch (err) {
			showToast(err instanceof Error ? err.message : String(err), "error");
		} finally {
			validatingDraft = false;
		}
	}

	async function saveWatch(): Promise<void> {
		if (watchCronValid === false) {
			showToast("Poll cron is not a valid cron expression", "error");
			return;
		}
		if (watchRepoErrors.repo || watchRepoErrors.webhookUrl || dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim())) {
			showToast("Fix the invalid fields before saving", "error");
			return;
		}
		savingWatch = true;
		try {
			const { ok } = editingWatchId
				? await updateWatch(editingWatchId, { ...watchForm, dispatchTargets })
				: await createWatch({ ...watchForm, dispatchTargets });
			if (ok) watchDialogOpen = false;
		} finally {
			savingWatch = false;
		}
	}

	async function removeWatch(w: AppWatch): Promise<void> {
		if (
			!(await confirmDialog(
				`Remove "${appDisplayName(w.bundleId)}"? Its scheduled checks stop immediately.`,
			))
		)
			return;
		const id = w.id;
		deletingWatch = new Set(deletingWatch).add(id);
		try {
			await deleteWatch(id);
		} finally {
			const next = new Set(deletingWatch);
			next.delete(id);
			deletingWatch = next;
		}
	}

	async function toggleWatchEnabled(w: AppWatch): Promise<void> {
		await updateWatch(w.id, { enabled: !w.enabled });
	}

	async function refreshWatchedCatalog(): Promise<void> {
		refreshingCatalog = true;
		try {
			if (await refreshAppCatalog(watches.map((watch) => watch.bundleId))) {
				appCatalogStats = await fetchAppCatalogStats();
				showToast("App metadata refreshed", "success");
			}
		} finally {
			refreshingCatalog = false;
		}
	}

	async function importWatchFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importingWatches = true;
		try {
			const parsed = JSON.parse(await file.text()) as { watches?: WatchInput[] };
			if (!Array.isArray(parsed.watches)) throw new Error("This file does not contain watches");
			const { ok, data } = await importWatches(parsed.watches);
			if (ok && data.skipped.length) showToast(`${data.watches.length} watches imported; ${data.skipped.length} skipped`, "success");
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Could not import watches", "error");
		} finally {
			input.value = "";
			importingWatches = false;
		}
	}

	type PreviewProgress = {
		source: "appStore" | "testflight";
		label: string;
		detail: string;
		state: "checking" | "complete" | "failed";
	};

	function updatePreviewProgress(
		id: string,
		source: PreviewProgress["source"],
		detail: string,
		state: PreviewProgress["state"],
	): void {
		const previous = previewProgressByWatch[id] ?? [];
		const label = source === "appStore" ? "App Store" : "TestFlight";
		const next = previous.filter((entry) => entry.source !== source);
		previewProgressByWatch = {
			...previewProgressByWatch,
			[id]: [...next, { source, label, detail, state }],
		};
	}

	function failedPreviewCheck(reason: string): UpdateCheck {
		return { ok: false, wouldDispatch: false, reason };
	}

	async function runPreviewWatch(id: string): Promise<void> {
		previewingWatch = new Set(previewingWatch).add(id);
		previewByWatch = { ...previewByWatch, [id]: null };
		previewProgressByWatch = {
			...previewProgressByWatch,
			[id]: [
				{
					source: "appStore",
					label: "App Store",
					detail: "Looking up the live version and published releases…",
					state: "checking",
				},
				{
					source: "testflight",
					label: "TestFlight",
					detail: "Checking the TestFlight catalog and published builds…",
					state: "checking",
				},
			],
		};
		try {
			const [appStore, testflight] = await Promise.all([
				previewWatchDispatchSource(id, "app-store")
					.then(({ result }) => {
						const check = result as UpdateCheck;
						updatePreviewProgress(
							id,
							"appStore",
							check.reason,
							check.ok ? "complete" : "failed",
						);
						return check;
					})
					.catch((err) => {
						const check = failedPreviewCheck(
							err instanceof Error ? err.message : String(err),
						);
						updatePreviewProgress(
							id,
							"appStore",
							check.reason,
							"failed",
						);
						return check;
					}),
				previewWatchDispatchSource(id, "testflight")
					.then(({ result }) => {
						const check = result as TestFlightUpdateCheck;
						updatePreviewProgress(
							id,
							"testflight",
							check.reason,
							check.ok ? "complete" : "failed",
						);
						return check;
					})
					.catch((err) => {
						const check = failedPreviewCheck(
							err instanceof Error ? err.message : String(err),
						) as TestFlightUpdateCheck;
						updatePreviewProgress(
							id,
							"testflight",
							check.reason,
							"failed",
						);
						return check;
					}),
			]);
			previewByWatch = {
				...previewByWatch,
				[id]: { ...appStore, testflight },
			};
		} finally {
			const next = new Set(previewingWatch);
			next.delete(id);
			previewingWatch = next;
		}
	}

	function dismissPreview(id: string): void {
		const next = { ...previewByWatch };
		delete next[id];
		previewByWatch = next;
		const progress = { ...previewProgressByWatch };
		delete progress[id];
		previewProgressByWatch = progress;
	}

	async function runTriggerWatch(id: string): Promise<void> {
		if (
			!(await confirmDialog(
				"Run a live check now? If there's a new version, it'll decrypt and dispatch for real.",
				{ variant: "default", confirmLabel: "Trigger now" },
			))
		)
			return;
		triggeringWatch = new Set(triggeringWatch).add(id);
		try {
			const { ok, data } = await triggerWatchDispatch(id);
			if (ok)
				showToast(
					"Dispatch check triggered - watch Active Jobs / Logs for progress",
					"success",
				);
			else showToast(data.error ?? "Failed to trigger", "error");
		} finally {
			const next = new Set(triggeringWatch);
			next.delete(id);
			triggeringWatch = next;
		}
	}

	const DEFAULT_FORM: SchedulerSettings = {
		notifyWebhookUrl: "",
		notifyFormat: "embed",
		notifySuccessMode: "instant",
		notifyQuietHoursStart: "",
		notifyQuietHoursEnd: "",
		notifyOnKeyRequest: true,
		notifyOnAutomationSuccess: true,
		notifyOnAutomationFailure: true,
		notifyOnKeyExpiringSoon: true,
		notifyOnDeviceOffline: true,
		notifyOnDeviceBatteryHot: true,
		notifyOnDeviceBatteryLow: true,
		notifyOnDiskFull: true,
		notifyOnDeviceStorageLow: true,
		notifyOnTestFlightBridgeDown: true,
		notifyOnJobCompleted: false,
		schedulerRetryCount: 0,
		deviceOfflineAlertMinutes: 15,
		batteryHotAlertC: 45,
		batteryLowAlertPercent: 10,
		diskFullAlertPercent: 90,
		deviceStorageAlertPercent: 90,
		testFlightBridgeAlertMinutes: 15,
		jobHistoryRetentionDays: 0,
		maintenanceMode: false,
	};

	let form = $state<SchedulerSettings>({ ...DEFAULT_FORM });
	let savedForm = $state<SchedulerSettings>({ ...DEFAULT_FORM });
	let settingsDialogOpen = $state(false);
	let testingWebhook = $state(false);
	let saving = $state(false);
	let deliveries = $state<WebhookDeliveryEntry[] | null>(null);

	$effect(() => {
		void fetchSettings().then((s) => {
			form = { ...s };
			savedForm = { ...s };
		});
	});

	function loadDeliveries(): void {
		void fetchWebhookDeliveries(10).then(
			(r) => (deliveries = r.deliveries),
		);
	}

	$effect(() => {
		loadDeliveries();
		const interval = setInterval(loadDeliveries, 30_000);
		return () => clearInterval(interval);
	});

	function openSettingsDialog(): void {
		form = { ...savedForm };
		settingsDialogOpen = true;
	}

	const repoErrors = $derived({
		notifyWebhookUrl:
			form.notifyWebhookUrl && !WEBHOOK_URL_RE.test(form.notifyWebhookUrl)
				? "Expected a full http(s):// URL"
				: "",
	});

	const enabledAlertCount = $derived(
		NOTIFY_EVENTS.filter((e) => savedForm[e.key]).length,
	);
	const notificationGroups = ["Automation", "Access", "Device", "Capacity"] as const;

	function applyNotificationPreset(preset: "essential" | "all" | "quiet"): void {
		const enabled = new Set<keyof SchedulerSettings>(
			preset === "all"
				? NOTIFY_EVENTS.map((event) => event.key)
				: preset === "essential"
					? ["notifyOnAutomationFailure", "notifyOnKeyRequest", "notifyOnDeviceOffline", "notifyOnTestFlightBridgeDown", "notifyOnDiskFull"]
					: ["notifyOnAutomationFailure", "notifyOnDeviceOffline", "notifyOnTestFlightBridgeDown"],
		);
		form = Object.fromEntries(
			Object.entries(form).map(([key, value]) => [key, NOTIFY_EVENTS.some((event) => event.key === key) ? enabled.has(key as keyof SchedulerSettings) : value]),
		) as SchedulerSettings;
	}

	async function save(): Promise<void> {
		if (repoErrors.notifyWebhookUrl) {
			showToast("Fix the invalid fields before saving", "error");
			return;
		}
		saving = true;
		try {
			const { ok, data } = await saveSettings(form);
			if (ok) {
				form = { ...data };
				savedForm = { ...data };
				settingsDialogOpen = false;
			}
		} finally {
			saving = false;
		}
	}

	async function runTestWebhook(): Promise<void> {
		testingWebhook = true;
		try {
			const { data } = await testWebhook(
				form.notifyWebhookUrl || undefined,
			);
			showToast(
				data.ok
					? "Test notification sent"
					: (data.error ?? "Failed to send"),
				data.ok ? "success" : "error",
			);
		} finally {
			testingWebhook = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<Card title="Automation health">
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<Badge variant={failedWatchCount > 0 ? "destructive" : "success"}>{failedWatchCount > 0 ? "attention needed" : "healthy"}</Badge>
			<span class="text-muted">{healthyWatchCount} healthy · {failedWatchCount} needs attention · {watches.filter((watch) => watch.schedulable).length} active</span>
			{#if canManageSchedulerSettings}
				<div class="ml-auto flex flex-wrap items-center gap-1.5">
					<Button size="sm" variant="secondary" loading={loadingBridgeDiagnostics} onclick={openBridgeDiagnostics}>Inspect autoinstall</Button>
				</div>
			{/if}
		</div>
		<div class="mt-2 flex items-center gap-2 text-xs text-muted">
			<span>{appCatalogStats ? `${appCatalogStats.entries} catalogued apps · ${appCatalogStats.icons} icons cached` : "Loading app catalog…"}</span>
			{#if canManageWatches}
				<Button size="sm" variant="secondary" class="ml-auto" loading={refreshingCatalog} onclick={refreshWatchedCatalog}>Refresh app metadata</Button>
			{/if}
		</div>
		{#if githubRateLimit?.remaining !== undefined}
			<div class="border-border mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-xs">
				<Badge variant={githubRateLimit.remaining < 100 ? "destructive" : "secondary"}>GitHub API</Badge>
				<span class="font-medium">{githubRateLimit.remaining}/{githubRateLimit.limit ?? "?"} remaining</span>
				{#if githubRateLimit.reset}<span class="text-muted">resets {new Date(githubRateLimit.reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{/if}
			</div>
		{/if}
		{#if githubBudgetTelemetry.length > 0}
			<div class="border-border mt-2 rounded-lg border px-2.5 py-2 text-xs">
				<div class="mb-1 font-medium">Recent scheduler GitHub budget</div>
				<div class="flex flex-col gap-1 text-muted">
					{#each githubBudgetTelemetry.slice(0, 5) as entry (entry.id)}
						<div class="flex justify-between gap-2"><span class="truncate">{appDisplayName(entry.bundleId)}</span><span class="shrink-0">{entry.observedRequests === undefined ? "usage unavailable" : `${entry.observedRequests} observed`} · {entry.estimatedRequests} reserved</span></div>
					{/each}
				</div>
			</div>
		{/if}
	</Card>

	<Card title="Watches">
		{#snippet headerExtra()}
			{#if canManageWatches}
				<div class="flex items-center gap-1.5">
					<input class="hidden" bind:this={watchImportInput} type="file" accept="application/json" onchange={importWatchFile} />
					<Button size="sm" variant="secondary" onclick={() => watchImportInput?.click()} loading={importingWatches}>Import</Button>
					<a class={buttonVariants("secondary", "sm")} href={watchesExportUrl()}>Export</a>
					<Button size="sm" onclick={openAddWatch}>
						<Plus class="h-3.5 w-3.5" />
						Add watch
					</Button>
				</div>
			{/if}
		{/snippet}
		{#if watches.length === 0}
			<EmptyState
				message="No watches configured yet - add one to have dkrypt track an app for new releases."
			/>
		{:else}
			<div class="flex flex-col gap-2.5">
				{#each watches as w (w.id)}
					<div class="border-border rounded-lg border p-3">
						<div class="flex flex-wrap items-center gap-2">
							<span
								class="flex items-center gap-1.5 text-[13px] font-medium"
							>
								<AppIcon bundleId={w.bundleId} src={appIconUrl(w.bundleId)} label={appDisplayName(w.bundleId)} class="h-4 w-4" />
								<span>{appDisplayName(w.bundleId)}</span>
							</span>
							<Badge
								variant={w.schedulable
									? "success"
									: "secondary"}
								>{w.schedulable ? "watching" : "off"}</Badge
							>
							{#if w.nextRunAt}
								<span class="text-xs text-muted"
									>next run <RelativeTime
										ms={w.nextRunAt}
									/></span
								>
							{/if}
							<div class="ml-auto flex flex-wrap gap-1.5">
								{#if canManageWatches}
									<Switch
										checked={w.enabled}
										onCheckedChange={() =>
											void toggleWatchEnabled(w)}
										aria-label="Enable {w.bundleId}"
									/>
									<Button
										size="sm"
										variant="secondary"
										onclick={() => openEditWatch(w)}
										>Edit</Button
									>
									<Button
										size="sm"
										variant="destructive"
										loading={deletingWatch.has(w.id)}
										onclick={() => removeWatch(w)}
										>Remove</Button
									>
								{/if}
								{#if canTriggerDispatch}
									<Button
										size="sm"
										variant="secondary"
										loading={previewingWatch.has(w.id)}
										onclick={() => runPreviewWatch(w.id)}
										>Preview</Button
									>
									<Button
										size="sm"
										variant="secondary"
										loading={triggeringWatch.has(w.id)}
										onclick={() => runTriggerWatch(w.id)}
										>Trigger now</Button
									>
								{/if}
							</div>
						</div>
						<div
							class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted"
						>
							<span title={w.repo}>{w.dispatchTargets?.length ? `${w.dispatchTargets.length} destinations` : w.repo || "-"}</span>
							<span title="poll cron">{w.pollCron}</span>
							{#if healthForWatch(w.id)?.schedulerJobSuccessRate !== undefined}
								<span class="font-sans">{Math.round((healthForWatch(w.id)?.schedulerJobSuccessRate ?? 0) * 100)}% scheduler success</span>
							{/if}
							{#if healthForWatch(w.id)?.medianSchedulerJobDurationMs}
								<span class="font-sans">{Math.round((healthForWatch(w.id)?.medianSchedulerJobDurationMs ?? 0) / 60_000)}m median decrypt</span>
							{/if}
						</div>
						{#if w.configIssues.length > 0}
							<div class="mt-1.5 text-xs text-warn">
								{w.configIssues.join(" ")}
							</div>
						{/if}
						{#if previewProgressByWatch[w.id]}
							<div
								class="border-border bg-panel-muted mt-2 rounded-md border p-2.5 text-xs"
								aria-live="polite"
							>
								<div
									class="mb-1.5 flex items-center gap-2 font-medium"
								>
									<span>Preview activity</span>
									{#if previewByWatch[w.id]}
										<button
											type="button"
											class="text-muted hover:text-text ml-auto cursor-pointer"
											onclick={() => dismissPreview(w.id)}
											aria-label="Dismiss preview"
											title="Dismiss"
										>
											<X class="h-3.5 w-3.5" />
										</button>
									{/if}
								</div>
								<div
									class="flex flex-col gap-1.5 font-mono text-[11px]"
								>
									{#each previewProgressByWatch[w.id] as progress (progress.source)}
										<div class="flex items-start gap-1.5">
											{#if progress.state === "checking"}
												<LoaderCircle
													class="text-accent mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin"
												/>
											{:else if progress.state === "complete"}
												<CircleCheck
													class="text-ok mt-0.5 h-3.5 w-3.5 shrink-0"
												/>
											{:else}
												<TriangleAlert
													class="text-err mt-0.5 h-3.5 w-3.5 shrink-0"
												/>
											{/if}
											<span class="text-muted shrink-0"
												>{progress.label}</span
											>
											<span
												class={progress.state ===
												"failed"
													? "text-err"
													: "text-text"}
												>{progress.detail}</span
											>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</Card>

	<Card title="Notifications & alerts">
		{#snippet headerExtra()}
			<Button size="sm" variant="secondary" onclick={openSettingsDialog}
				>{canManageSchedulerSettings ? "Edit" : "View"}</Button
			>
		{/snippet}
		<dl class="flex flex-col gap-2 text-sm">
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Webhook</dt>
				<dd>
					{#if savedForm.notifyWebhookUrl}
						<Badge variant="success">Configured</Badge>
					{:else}
						<Badge variant="secondary">Not set</Badge>
					{/if}
				</dd>
			</div>
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Alerts enabled</dt>
				<dd>{enabledAlertCount} / {NOTIFY_EVENTS.length}</dd>
			</div>
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Retry on failure</dt>
				<dd>
					{RETRY_OPTIONS.find(
						(o) =>
							o.value === String(savedForm.schedulerRetryCount),
					)?.label}
				</dd>
			</div>
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Job history retention</dt>
				<dd class="text-right">
					{RETENTION_OPTIONS.find(
						(o) =>
							o.value ===
							String(savedForm.jobHistoryRetentionDays),
					)?.label}
				</dd>
			</div>
		</dl>
	</Card>

	{#if deliveries !== null}
		<Card title="Recent webhook deliveries">
			{#if deliveries.length === 0}
				<EmptyState message="No webhook deliveries yet." />
			{:else}
				<div class="flex flex-col gap-1.5">
					{#each deliveries as d (d.id)}
						<div
							class="border-border flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-xs"
						>
							<span class="w-14 shrink-0 text-muted"
								><RelativeTime ms={d.ts} /></span
							>
							<Badge
								variant={d.ok ? "success" : "destructive"}
								class="shrink-0">{d.ok ? "ok" : "failed"}</Badge
							>
							<span class="shrink-0 font-mono">{d.event}</span>
							<span
								class="min-w-0 flex-1 truncate text-muted"
								title={d.targetHost}>{d.targetHost}</span
							>
							{#if d.error}
								<span
									class="max-w-40 truncate text-err"
									title={d.error}>{d.error}</span
								>
							{:else if d.status}
								<span class="text-muted">{d.status}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card>
	{/if}
</div>

<Dialog open={bridgeDiagnosticsOpen} onOpenChange={(value) => (bridgeDiagnosticsOpen = value)} class="max-w-lg">
	<div class="mb-1 text-sm font-medium">autoinstall protocol explorer</div>
	<div class="mb-3 text-xs text-muted">Live bridge version, exposed capabilities, and the most recent protocol activity.</div>
	{#if loadingBridgeDiagnostics}
		<div class="text-sm text-muted">Checking the autoinstall bridge…</div>
	{:else if bridgeDiagnostics}
		<div class="grid grid-cols-2 gap-2 text-xs">
			<div class="border-border rounded-md border p-2">Version <span class="text-muted">{bridgeDiagnostics.bridge.bridgeVersion ?? "unknown"}</span></div>
			<div class="border-border rounded-md border p-2">Catalog <span class={bridgeDiagnostics.bridge.hasCatalogManager ? "text-ok" : "text-err"}>{bridgeDiagnostics.bridge.hasCatalogManager ? "ready" : "missing"}</span></div>
			<div class="border-border rounded-md border p-2">Installer <span class={bridgeDiagnostics.bridge.hasInstaller ? "text-ok" : "text-err"}>{bridgeDiagnostics.bridge.hasInstaller ? "ready" : "missing"}</span></div>
			<div class="border-border rounded-md border p-2">Install <span class="text-muted">{String(bridgeDiagnostics.install?.state ?? "idle")}</span></div>
		</div>
		<div class="mt-3 flex flex-wrap gap-1.5">
			{#each bridgeDiagnostics.bridge.capabilities ?? [] as capability (capability)}
				<Badge variant="secondary">{capability}</Badge>
			{:else}
				<span class="text-xs text-muted">No capabilities reported.</span>
			{/each}
		</div>
		{#if bridgeDiagnostics.recentLog?.length}
			<pre class="bg-panel-muted mt-3 max-h-64 overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap">{bridgeDiagnostics.recentLog.join("\n")}</pre>
		{/if}
	{:else}
		<div class="text-sm text-muted">No diagnostics available.</div>
	{/if}
</Dialog>

{#if canManageWatches}
	<Dialog
		open={watchDialogOpen}
		onOpenChange={(v) => (watchDialogOpen = v)}
		class="max-w-md"
	>
		<div class="mb-3 text-sm font-medium">
			{editingWatchId ? "Edit watch" : "Add watch"}
		</div>
		<div class="max-h-[60vh] overflow-y-auto pr-0.5">
			<label for="w-search" class="mb-1 block text-xs text-muted"
				>App search</label
			>
			<div class="relative">
				<Input
					id="w-search"
					placeholder="Search App Store app name or bundle ID"
					bind:value={watchSearchTerm}
					oninput={onWatchSearchInput}
					class="pr-8"
				/>
				<div
					class="text-muted pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
				>
					{#if watchSearchLoading}
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
					{:else}
						<Search class="h-3.5 w-3.5" />
					{/if}
				</div>
			</div>
			{#if watchSearchResults.length > 0}
				<div
					class="border-border mt-1.5 max-h-52 overflow-y-auto rounded-md border"
				>
					{#each watchSearchResults as result (result.bundleId)}
						<button
							type="button"
							class="border-border hover:bg-panel-muted flex w-full cursor-pointer items-center gap-2 border-b px-2.5 py-2 text-left last:border-0"
							onclick={() => pickWatchApp(result)}
						>
							{#if result.artworkUrl}
								<img
									src={result.artworkUrl}
									alt=""
									class="h-5 w-5 shrink-0 rounded"
								/>
							{/if}
							<div class="min-w-0 flex-1">
								<div class="truncate text-[13px] font-medium">
									{result.trackName}
								</div>
								<div class="truncate text-[11px] text-muted" title={result.bundleId}>
									v{result.version} · {result.sellerName}{result.category ? ` · ${result.category}` : ""}
								</div>
							</div>
						</button>
					{/each}
				</div>
			{:else if watchSearchSearched && watchSearchTerm.trim()}
				<div class="mt-1 text-xs text-muted">No apps found.</div>
			{/if}

			<div class="mt-3 text-xs text-muted">Selected app</div>
			<div class="mt-1 truncate text-sm" title={watchForm.bundleId}>
				{watchForm.bundleId
					? appDisplayName(watchForm.bundleId)
					: "Choose an app from search"}
			</div>

			<label for="w-testFlightPolicy" class="mt-3 mb-1 block text-xs text-muted"
				>TestFlight build policy</label
			>
			<Select
				id="w-testFlightPolicy"
				items={TESTFLIGHT_POLICY_OPTIONS}
				value={watchForm.testFlightPolicy ?? "latest"}
				onValueChange={(value) =>
					(watchForm = {
						...watchForm,
						testFlightPolicy: value as WatchInput["testFlightPolicy"],
					})}
				class="w-full"
			/>
			{#if watchForm.testFlightPolicy === "train"}
				<label for="w-testFlightTrain" class="mt-2 mb-1 block text-xs text-muted"
					>Train version</label
				>
				<Input id="w-testFlightTrain" placeholder="341.0" bind:value={watchForm.testFlightTrain} />
			{/if}

			<div class="mt-3 flex items-center justify-between gap-3">
				<div class="text-xs text-muted">Dispatch destinations</div>
				<Button size="sm" variant="secondary" onclick={addDispatchTarget}>Add destination</Button>
			</div>
			<div class="mt-1.5 flex flex-col gap-2">
				{#each dispatchTargets as target, index (`${index}-${target.repo}-${target.ghWorkflowFile}`)}
					<div class="border-border rounded-lg border p-2.5">
						<div class="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
							<span>Destination {index + 1}</span>
							{#if dispatchTargets.length > 1}
								<button type="button" class="hover:text-err cursor-pointer" onclick={() => removeDispatchTarget(index)}>Remove</button>
							{/if}
						</div>
						<label for={`w-repo-${index}`} class="mb-1 block text-[11px] text-muted">Repository</label>
						<SearchSelect
							id={`w-repo-${index}`}
							items={repoItemsFor(target.repo)}
							value={target.repo}
							placeholder="Search repositories…"
							onValueChange={(repo) => onWatchRepoChange(index, repo)}
							class="w-full"
						/>
						<label for={`w-workflow-${index}`} class="mt-2 mb-1 block text-[11px] text-muted">Workflow</label>
						<SearchSelect
							id={`w-workflow-${index}`}
							items={workflowItemsFor(target.repo, target.ghWorkflowFile)}
							value={target.ghWorkflowFile}
							placeholder="Search workflows…"
							onValueChange={(workflow) => onWatchWorkflowChange(index, workflow)}
							class="w-full"
						/>
						<label for={`w-mode-${index}`} class="mt-2 mb-1 block text-[11px] text-muted">Trigger</label>
						<Select
							id={`w-mode-${index}`}
							items={DISPATCH_MODE_OPTIONS}
							value={target.mode ?? "repository_dispatch"}
							onValueChange={(mode) => setDispatchTarget(index, { mode: mode as DispatchTarget["mode"] })}
							class="w-full"
						/>
						{#if target.mode === "workflow_dispatch"}
							<label for={`w-ref-${index}`} class="mt-2 mb-1 block text-[11px] text-muted">Branch or tag</label>
							<Input id={`w-ref-${index}`} placeholder="Default branch" value={target.ref ?? ""} onchange={(event) => setDispatchTarget(index, { ref: event.currentTarget.value })} />
						{/if}
						{#if githubWorkflowErrors[target.repo]}
							<div class="mt-1 text-xs text-err">{githubWorkflowErrors[target.repo]}</div>
						{/if}
						<div class="mt-2.5 flex items-center justify-between gap-2">
							<span class="text-[11px] text-muted">Workflow payload inputs</span>
							<Button size="sm" variant="secondary" onclick={() => addDispatchInput(index)}>Add input</Button>
						</div>
						{#each Object.entries(target.inputs ?? {}) as [key, value] (key)}
							<div class="mt-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
								<Input value={key} aria-label="Input name" onchange={(event) => setDispatchInput(index, key, event.currentTarget.value, value)} />
								<Input value={value} aria-label="Input value" onchange={(event) => setDispatchInput(index, key, key, event.currentTarget.value)} />
							</div>
						{/each}
					</div>
				{/each}
			</div>
			{#if githubReposError}
				<div class="mt-1 text-xs text-err">{githubReposError}</div>
			{/if}
			{#if watchRepoErrors.repo}
				<div class="mt-1 text-xs text-err">{watchRepoErrors.repo}</div>
			{/if}

			<label for="w-pollCron" class="mt-3 mb-1 block text-xs text-muted"
				>Poll cron</label
			>
			<Input id="w-pollCron" bind:value={watchForm.pollCron} />
			{#if watchCronValid === false}
				<div class="mt-1 text-xs text-err">
					Not a valid cron expression
				</div>
			{/if}
			<div class="mt-1.5 flex flex-wrap gap-1.5">
				{#each CRON_PRESETS as p (p.expr)}
					<button
						type="button"
						class="border-border text-muted hover:text-text hover:border-accent cursor-pointer rounded-full border px-2.5 py-1 text-[12px]"
						onclick={() => applyCronPreset(p.expr)}
					>
						{p.label}
					</button>
				{/each}
			</div>

			<label for="w-webhookUrl" class="mt-3 mb-1 block text-xs text-muted"
				>Webhook override (optional)</label
			>
			<Input
				id="w-webhookUrl"
				placeholder="blank = use the default webhook"
				bind:value={watchForm.webhookUrl}
			/>
			{#if watchRepoErrors.webhookUrl}
				<div class="mt-1 text-xs text-err">
					{watchRepoErrors.webhookUrl}
				</div>
			{/if}
			<div class="mt-1 text-[11px] text-muted">
				Send this watch's dispatch notifications to a different
				Discord/Slack channel.
			</div>

			<Button
				variant="secondary"
				class="mt-3.5 w-full"
				loading={previewingDraft}
				disabled={!watchForm.bundleId.trim() ||
					!watchForm.repo.trim() ||
					!!watchRepoErrors.repo}
				onclick={previewDraft}
			>
				Preview what this would do
			</Button>
			<Button
				variant="secondary"
				class="mt-2 w-full"
				loading={validatingDraft}
				disabled={dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim())}
				onclick={validateDraftDispatch}
			>
				Validate GitHub destinations
			</Button>
			{#if dispatchValidation}
				<div class="border-border bg-panel-muted mt-2 rounded-md border p-2.5 text-xs">
					{#each dispatchValidation as result (`${result.repo}-${result.workflow}`)}
						<div class={result.ok ? "text-ok" : "text-err"}>{result.repo} · {result.workflow}</div>
						{#each result.checks as check (check.label)}
							<div class="mt-1 text-muted"><span class={check.ok ? "text-ok" : "text-err"}>{check.ok ? "✓" : "×"}</span> {check.label}: {check.detail}</div>
						{/each}
					{/each}
				</div>
			{/if}
			{#if draftPreview}
				<div
					class="border-border bg-panel-muted mt-2 rounded-md border p-2.5 text-xs"
				>
					<div
						class={draftPreview.wouldDispatch
							? "text-ok"
							: "text-muted"}
					>
						{draftPreview.reason}
					</div>
					{#if draftPreview.testflight}
						<div class="border-border mt-1.5 border-t pt-1.5">
							<div
								class={draftPreview.testflight.wouldDispatch
									? "text-ok"
									: "text-muted"}
							>
								{draftPreview.testflight.reason}
							</div>
						</div>
					{/if}
				</div>
			{:else if draftPreviewError}
				<div class="mt-2 text-xs text-err">{draftPreviewError}</div>
			{/if}
		</div>
		<Button class="mt-3.5 w-full" loading={savingWatch} onclick={saveWatch}
			>{editingWatchId ? "Save" : "Add"}</Button
		>
	</Dialog>
{/if}

<Dialog
	open={settingsDialogOpen}
	onOpenChange={(v) => (settingsDialogOpen = v)}
	class="max-w-md"
>
	<div class="mb-3 text-sm font-medium">Notifications & alerts</div>
	<div class="max-h-[70vh] overflow-y-auto pr-0.5">
		{#if !canManageSchedulerSettings}
			<div
				class="border-border bg-panel-muted mb-3.5 rounded-md border p-2.5 text-xs text-muted"
			>
				You can operate the scheduler but not change its configuration -
				fields below are read-only.
			</div>
		{/if}

		<label for="s-notifyWebhookUrl" class="mb-1 block text-xs text-muted"
			>Webhook URL (Discord/Slack-compatible, optional)</label
		>
		<div class="flex gap-2">
			<Input
				id="s-notifyWebhookUrl"
				bind:value={form.notifyWebhookUrl}
				disabled={!canManageSchedulerSettings}
			/>
			{#if canTriggerDispatch}
				<Button
					variant="secondary"
					loading={testingWebhook}
					onclick={runTestWebhook}>Test</Button
				>
			{/if}
		</div>
		<div class="mt-1 text-xs text-muted">
			One webhook for everything below - test sends to whatever's
			currently typed above, saved or not.
		</div>
		{#if repoErrors.notifyWebhookUrl}
			<div class="mt-1 text-xs text-err">
				{repoErrors.notifyWebhookUrl}
			</div>
		{/if}

		<label for="s-notifyFormat" class="mt-3 mb-1 block text-xs text-muted"
			>Webhook format</label
		>
		<Select
			id="s-notifyFormat"
			items={FORMAT_OPTIONS}
			value={form.notifyFormat}
			onValueChange={(v) =>
				(form = {
					...form,
					notifyFormat: v as SchedulerSettings["notifyFormat"],
				})}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-successDelivery" class="mt-3 mb-1 block text-xs text-muted"
			>Successful automation delivery</label
		>
		<Select
			id="s-successDelivery"
			items={SUCCESS_DELIVERY_OPTIONS}
			value={form.notifySuccessMode}
			onValueChange={(value) =>
				(form = {
					...form,
					notifySuccessMode: value as SchedulerSettings["notifySuccessMode"],
				})}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
		<div class="mt-1 text-xs text-muted">
			Failures remain immediate. Digests include successful decrypts and completed automation runs.
		</div>

		<div class="mt-3 grid grid-cols-2 gap-2">
			<div>
				<label for="s-quietStart" class="mb-1 block text-xs text-muted">Quiet hours start</label>
				<Input id="s-quietStart" type="time" bind:value={form.notifyQuietHoursStart} disabled={!canManageSchedulerSettings} />
			</div>
			<div>
				<label for="s-quietEnd" class="mb-1 block text-xs text-muted">Quiet hours end</label>
				<Input id="s-quietEnd" type="time" bind:value={form.notifyQuietHoursEnd} disabled={!canManageSchedulerSettings} />
			</div>
		</div>

		<div class="mt-3 flex items-center justify-between gap-2">
			<div class="text-xs text-muted">Notification events</div>
			<div class="flex gap-1">
				<button type="button" class="border-border hover:text-text cursor-pointer rounded-full border px-2 py-1 text-[11px] text-muted" onclick={() => applyNotificationPreset("essential")}>Essential</button>
				<button type="button" class="border-border hover:text-text cursor-pointer rounded-full border px-2 py-1 text-[11px] text-muted" onclick={() => applyNotificationPreset("all")}>All</button>
				<button type="button" class="border-border hover:text-text cursor-pointer rounded-full border px-2 py-1 text-[11px] text-muted" onclick={() => applyNotificationPreset("quiet")}>Quiet</button>
			</div>
		</div>
		<div class="mt-1.5 flex flex-col gap-2">
			{#each notificationGroups as group (group)}
				<div class="border-border divide-border overflow-hidden rounded-lg border divide-y">
					<div class="bg-panel-muted/50 px-3 py-1.5 text-[11px] font-medium text-muted">{group}</div>
					{#each NOTIFY_EVENTS.filter((event) => event.group === group) as event (event.key)}
						<div class="flex items-center gap-3 px-3 py-2">
					<div class="min-w-0 flex-1">
						<div class="text-[13px] text-text">{event.label}</div>
						<div class="text-[11px] text-muted">
							{event.description}
						</div>
					</div>
					<Popover>
						{#snippet trigger()}
							<span
								class="text-muted hover:text-text cursor-pointer text-[11px] underline-offset-2 hover:underline"
								>payload</span
							>
						{/snippet}
						<div class="max-w-xs">
							<div class="mb-1.5 text-[11px] text-muted">
								Example payload for this event ({form.notifyFormat})
							</div>
							<pre
								class="bg-panel-muted max-h-64 max-w-72 overflow-auto rounded-md p-2 text-[10.5px] leading-snug whitespace-pre-wrap">{exampleWebhookPayload(
									event.key,
									form.notifyFormat,
								)}</pre>
							<div class="mt-1.5">
								<CopyButton
									text={exampleWebhookPayload(
										event.key,
										form.notifyFormat,
									)}
									label="Copy"
								/>
							</div>
						</div>
					</Popover>
					<Switch
						checked={form[event.key] as boolean}
						disabled={!canManageSchedulerSettings}
						onCheckedChange={(checked) =>
							(form = { ...form, [event.key]: checked })}
						aria-label={event.label}
					/>
						</div>
					{/each}
				</div>
			{/each}
		</div>

		<label for="s-retryCount" class="mt-3 mb-1 block text-xs text-muted"
			>Retry a failed check before recording/notifying failure</label
		>
		<Select
			id="s-retryCount"
			items={RETRY_OPTIONS}
			value={String(form.schedulerRetryCount)}
			onValueChange={(v) =>
				(form = { ...form, schedulerRetryCount: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
		<div class="mt-1 text-xs text-muted">
			Retries back off: 30s, 60s, 120s… Applies to every watch.
		</div>

		<label for="s-retention" class="mt-3 mb-1 block text-xs text-muted"
			>Job history retention</label
		>
		<Select
			id="s-retention"
			items={RETENTION_OPTIONS}
			value={String(form.jobHistoryRetentionDays)}
			onValueChange={(v) =>
				(form = { ...form, jobHistoryRetentionDays: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-offlineMinutes" class="mt-3 mb-1 block text-xs text-muted"
			>iDevice offline alert threshold</label
		>
		<Select
			id="s-offlineMinutes"
			items={OFFLINE_ALERT_OPTIONS}
			value={String(form.deviceOfflineAlertMinutes)}
			onValueChange={(v) =>
				(form = { ...form, deviceOfflineAlertMinutes: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-batteryHot" class="mt-3 mb-1 block text-xs text-muted"
			>Battery hot alert threshold</label
		>
		<Select
			id="s-batteryHot"
			items={BATTERY_HOT_ALERT_OPTIONS}
			value={String(form.batteryHotAlertC)}
			onValueChange={(v) =>
				(form = { ...form, batteryHotAlertC: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-batteryLow" class="mt-3 mb-1 block text-xs text-muted"
			>Battery low alert threshold (while not charging)</label
		>
		<Select
			id="s-batteryLow"
			items={BATTERY_LOW_ALERT_OPTIONS}
			value={String(form.batteryLowAlertPercent)}
			onValueChange={(v) =>
				(form = { ...form, batteryLowAlertPercent: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-diskFull" class="mt-3 mb-1 block text-xs text-muted"
			>Staging disk full alert threshold</label
		>
		<Select
			id="s-diskFull"
			items={STORAGE_ALERT_OPTIONS}
			value={String(form.diskFullAlertPercent)}
			onValueChange={(v) =>
				(form = { ...form, diskFullAlertPercent: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-deviceStorage" class="mt-3 mb-1 block text-xs text-muted"
			>iDevice storage alert threshold</label
		>
		<Select
			id="s-deviceStorage"
			items={STORAGE_ALERT_OPTIONS}
			value={String(form.deviceStorageAlertPercent)}
			onValueChange={(v) =>
				(form = { ...form, deviceStorageAlertPercent: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-bridgeDown" class="mt-3 mb-1 block text-xs text-muted"
			>autoinstall bridge unresponsive alert threshold</label
		>
		<Select
			id="s-bridgeDown"
			items={TESTFLIGHT_BRIDGE_ALERT_OPTIONS}
			value={String(form.testFlightBridgeAlertMinutes)}
			onValueChange={(v) =>
				(form = { ...form, testFlightBridgeAlertMinutes: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
	</div>

	{#if canManageSchedulerSettings}
		<Button class="mt-3.5 w-full" loading={saving} onclick={save}
			>Save</Button
		>
	{/if}
</Dialog>
