<script lang="ts">
	import {
		CircleCheck,
		LoaderCircle,
		Plus,
		RefreshCw,
		Search,
		TriangleAlert,
		X,
	} from "lucide-svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import {
		createWatch,
		deleteWatch,
		fetchSettings,
		fetchWebhookDeliveries,
		fetchGithubRepos,
		fetchGithubWorkflows,
		previewWatchDispatchSource,
		previewWatchDispatchDraft,
		saveSettings,
		searchApps,
		testWebhook,
		triggerWatchDispatch,
		updateWatch,
		validateCron,
		type AppWatch,
		type AppStoreSearchResult,
		type GithubRepoOption,
		type GithubWorkflowOption,
		type SchedulerSettings,
		type TestFlightUpdateCheck,
		type UpdateCheck,
		type WatchInput,
		type WebhookDeliveryEntry,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import Select from "#lib/components/ui/Select.svelte";
	import Switch from "#lib/components/ui/Switch.svelte";
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

	const NOTIFY_EVENTS: {
		key: keyof SchedulerSettings;
		label: string;
		description: string;
	}[] = [
		{
			key: "notifyOnJobCompleted",
			label: "Any decrypt finishes",
			description:
				"Manual or scheduler jobs, including App Store and TestFlight paths",
		},
		{
			key: "notifyOnKeyRequest",
			label: "API key requests",
			description: "A user without approveApiKeys requests a new key",
		},
		{
			key: "notifyOnAutomationSuccess",
			label: "Automation succeeded",
			description:
				"A watched App Store or TestFlight release completed its GitHub workflow",
		},
		{
			key: "notifyOnAutomationFailure",
			label: "Automation needs attention",
			description:
				"A watched App Store or TestFlight release failed a check, decrypt, dispatch, or workflow",
		},
		{
			key: "notifyOnKeyExpiringSoon",
			label: "API key expiring soon",
			description:
				"An approved key has 7 days or less left before it expires",
		},
		{
			key: "notifyOnDeviceOffline",
			label: "iDevice unreachable",
			description:
				"A device stays unreachable past the alert threshold below",
		},
		{
			key: "notifyOnDeviceBatteryHot",
			label: "iDevice battery hot",
			description:
				"Battery temperature reaches the alert threshold below",
		},
		{
			key: "notifyOnDeviceBatteryLow",
			label: "iDevice battery low",
			description:
				"Battery drops to the alert threshold below while not charging",
		},
		{
			key: "notifyOnDiskFull",
			label: "Staging disk full",
			description:
				"The host staging disk (OUTPUT_DIR) reaches the alert threshold below",
		},
		{
			key: "notifyOnDeviceStorageLow",
			label: "iDevice storage low",
			description:
				"A device's own storage reaches the alert threshold below",
		},
		{
			key: "notifyOnTestFlightBridgeDown",
			label: "Autoinstall bridge unresponsive",
			description:
				"The SpringBoard autoinstall bridge stops responding past the alert threshold below",
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
		pollCron: "0 * * * *",
		enabled: true,
		webhookUrl: "",
	};

	let watchDialogOpen = $state(false);
	let editingWatchId = $state<string | null>(null);
	let watchForm = $state<WatchInput>({ ...DEFAULT_WATCH_FORM });
	let watchCronValid = $state<boolean | null>(null);
	let savingWatch = $state(false);
	let previewByWatch = $state<Record<string, UpdateCheck | null>>({});
	let previewingWatch = $state<Set<string>>(new Set());
	let previewProgressByWatch = $state<Record<string, PreviewProgress[]>>({});
	let triggeringWatch = $state<Set<string>>(new Set());
	let deletingWatch = $state<Set<string>>(new Set());
	let refreshingAppInfo = $state(false);
	let watchSearchTerm = $state("");
	let watchSearchResults = $state<AppStoreSearchResult[]>([]);
	let watchSearchLoading = $state(false);
	let watchSearchSearched = $state(false);
	let watchSearchToken = 0;
	let githubRepos = $state<GithubRepoOption[]>([]);
	let githubReposLoading = $state(false);
	let githubReposError = $state("");
	let githubWorkflows = $state<GithubWorkflowOption[]>([]);
	let githubWorkflowsLoading = $state(false);
	let githubWorkflowsError = $state("");
	let githubWorkflowsToken = 0;

	const watches = $derived(liveState.overview?.watches ?? []);

	$effect(() => {
		void ensureAppCatalog(watches.map((watch) => watch.bundleId));
	});

	async function refreshWatchAppInfo(): Promise<void> {
		refreshingAppInfo = true;
		try {
			const ok = await refreshAppCatalog(watches.map((watch) => watch.bundleId));
			showToast(ok ? "App names and icons refreshed" : "Could not refresh app info", ok ? "success" : "error");
		} finally {
			refreshingAppInfo = false;
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

	const watchRepoItems = $derived.by(() => {
		const options = githubRepos.map((repo) => ({
			value: repo.fullName,
			label: `${repo.fullName}${repo.isPrivate ? " (private)" : ""}`,
		}));
		const current = watchForm.repo.trim();
		if (current && !options.some((option) => option.value === current)) {
			options.unshift({
				value: current,
				label: `${current} (current)`,
			});
		}
		return options;
	});

	const workflowItems = $derived.by(() => {
		const options = githubWorkflows.map((workflow) => ({
			value: workflowFileName(workflow.path),
			label: `${workflow.name} (${workflowFileName(workflow.path)})`,
		}));
		const current = watchForm.ghWorkflowFile.trim();
		if (current && !options.some((option) => option.value === current)) {
			options.unshift({
				value: current,
				label: `${current} (current)`,
			});
		}
		return options;
	});

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
		githubWorkflows = [];
		githubWorkflowsError = "";
		void loadGithubRepos();
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
		};
		watchSearchTerm = appDisplayName(w.bundleId);
		watchSearchResults = [];
		watchSearchSearched = false;
		watchSearchLoading = false;
		watchSearchToken += 1;
		void loadGithubRepos();
		void loadGithubWorkflows(w.repo);
		draftPreview = null;
		watchDialogOpen = true;
	}

	async function loadGithubRepos(): Promise<void> {
		if (githubRepos.length > 0) return;
		githubReposLoading = true;
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
		} finally {
			githubReposLoading = false;
		}
	}

	async function loadGithubWorkflows(repo: string): Promise<void> {
		const trimmed = repo.trim();
		const token = ++githubWorkflowsToken;
		githubWorkflowsError = "";
		if (!trimmed || !REPO_RE.test(trimmed)) {
			githubWorkflows = [];
			githubWorkflowsLoading = false;
			return;
		}
		githubWorkflowsLoading = true;
		try {
			const { workflows } = await fetchGithubWorkflows(trimmed);
			if (token !== githubWorkflowsToken) return;
			githubWorkflows = workflows;
		} catch (err) {
			if (token !== githubWorkflowsToken) return;
			githubWorkflows = [];
			githubWorkflowsError =
				err instanceof Error ? err.message : "Failed to load workflows";
		} finally {
			if (token === githubWorkflowsToken) {
				githubWorkflowsLoading = false;
			}
		}
	}

	function onWatchRepoChange(repo: string): void {
		watchForm = { ...watchForm, repo };
		void loadGithubWorkflows(repo);
	}

	function onWatchWorkflowChange(workflow: string): void {
		watchForm = { ...watchForm, ghWorkflowFile: workflow };
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

	async function saveWatch(): Promise<void> {
		if (watchCronValid === false) {
			showToast("Poll cron is not a valid cron expression", "error");
			return;
		}
		if (watchRepoErrors.repo || watchRepoErrors.webhookUrl) {
			showToast("Fix the invalid fields before saving", "error");
			return;
		}
		savingWatch = true;
		try {
			const { ok } = editingWatchId
				? await updateWatch(editingWatchId, watchForm)
				: await createWatch(watchForm);
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
	<Card title="Watches">
		{#snippet headerExtra()}
			{#if canManageWatches}
				<div class="flex items-center gap-1.5">
					<Button
						size="sm"
						variant="secondary"
						loading={refreshingAppInfo}
						disabled={watches.length === 0}
						onclick={refreshWatchAppInfo}
						title="Refresh cached app names and icons"
					>
						<RefreshCw class="h-3.5 w-3.5" />
						Refresh apps
					</Button>
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
								{#if appIconUrl(w.bundleId)}
									<img
										src={appIconUrl(w.bundleId)}
										alt=""
										class="h-4 w-4 shrink-0 rounded"
									/>
								{/if}
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
							<span title={w.repo}>{w.repo || "-"}</span>
							<span title="poll cron">{w.pollCron}</span>
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
									v{result.version} · {result.sellerName}
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

			<label for="w-repo" class="mt-3 mb-1 block text-xs text-muted"
				>Dispatch repository</label
			>
			{#if watchRepoItems.length > 0}
				<Select
					id="w-repo"
					items={watchRepoItems}
					value={watchForm.repo}
					onValueChange={onWatchRepoChange}
					disabled={githubReposLoading}
					class="w-full"
				/>
			{:else}
				<Input
					id="w-repo"
					placeholder="owner/repo"
					bind:value={watchForm.repo}
					oninput={() => void loadGithubWorkflows(watchForm.repo)}
				/>
			{/if}
			{#if githubReposLoading}
				<div class="mt-1 text-xs text-muted">
					Loading repositories...
				</div>
			{:else if githubReposError}
				<div class="mt-1 text-xs text-err">{githubReposError}</div>
			{/if}
			{#if watchRepoErrors.repo}
				<div class="mt-1 text-xs text-err">{watchRepoErrors.repo}</div>
			{/if}

			<label
				for="w-ghWorkflowFile"
				class="mt-3 mb-1 block text-xs text-muted">Workflow file</label
			>
			{#if workflowItems.length > 0}
				<Select
					id="w-ghWorkflowFile"
					items={workflowItems}
					value={watchForm.ghWorkflowFile}
					onValueChange={onWatchWorkflowChange}
					disabled={githubWorkflowsLoading || !watchForm.repo.trim()}
					class="w-full"
				/>
			{:else}
				<Input
					id="w-ghWorkflowFile"
					bind:value={watchForm.ghWorkflowFile}
				/>
			{/if}
			{#if githubWorkflowsLoading}
				<div class="mt-1 text-xs text-muted">Loading workflows...</div>
			{:else if githubWorkflowsError}
				<div class="mt-1 text-xs text-err">{githubWorkflowsError}</div>
			{:else if watchForm.repo.trim() && workflowItems.length === 0}
				<div class="mt-1 text-xs text-muted">
					No workflows found in this repository.
				</div>
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

		<div class="mt-3 mb-1 text-xs text-muted">Notify on</div>
		<div class="border-border divide-border divide-y rounded-lg border">
			{#each NOTIFY_EVENTS as event (event.key)}
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
			>TestFlight bridge unresponsive alert threshold</label
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
