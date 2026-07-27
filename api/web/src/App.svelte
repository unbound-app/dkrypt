<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import {
		BarChart3,
		BookOpen,
		Command,
		Download,
		Home as HomeIcon,
		KeyRound,
		Lock,
		LogOut,
		Monitor,
		Moon,
		Pencil,
		Rows2,
		Rows3,
		PanelRightOpen,
		ScrollText,
		Settings as SettingsIcon,
		Sun,
		Volume2,
		VolumeX,
		Wallet,
	} from "lucide-svelte";
	import { Toaster } from "svelte-sonner";
	import CommandPalette from "#components/CommandPalette.svelte";
	import ConfirmModal from "#components/ConfirmModal.svelte";
	import ConnectionBanner from "#components/ConnectionBanner.svelte";
	import MaintenanceBanner from "#components/MaintenanceBanner.svelte";
	import UpdateAvailableBanner from "#components/UpdateAvailableBanner.svelte";
	import HeaderOnlineUsers from "#components/HeaderOnlineUsers.svelte";
	import Login from "#components/Login.svelte";
	import LegalPage from "#components/LegalPage.svelte";
	import NotificationBell from "#components/NotificationBell.svelte";
	import WhatsNewButton from "#components/WhatsNewButton.svelte";
	import ContactPage from "#components/ContactPage.svelte";
	import PublicPricing from "#components/PublicPricing.svelte";
	import SessionExpiryBanner from "#components/SessionExpiryBanner.svelte";
	import SessionsDialog from "#components/SessionsDialog.svelte";
	import SetupBanner from "#components/SetupBanner.svelte";
	import OnboardingTour from "#components/OnboardingTour.svelte";
	import ShortcutsHelp from "#components/ShortcutsHelp.svelte";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { buttonVariants } from "#lib/components/ui/variants";
	import { cn } from "#lib/utils";
	import { KOFI_URL } from "#lib/constants";
	import { myDecryptsState } from "#lib/decrypts.svelte";
	import { connectLive, disconnectLive, liveState } from "#lib/live.svelte";
	import {
		disablePush,
		enablePush,
		getExistingPushSubscription,
		pushSupported,
		registerServiceWorker,
	} from "#lib/push";
	import {
		initInstallPromptWatcher,
		initPwaUpdateWatcher,
		promptPwaInstall,
		pwaState,
	} from "#lib/pwa.svelte";
	import { PermissionFlag } from "#lib/permissions";
	import {
		logout,
		logoutEverywhere,
		permissionsSummary,
		pushAccentPref,
		pushDensityPref,
		fetchNotificationPrefs,
		pushNotificationPrefs,
		pushSoundPref,
		pushThemePref,
		refreshSession,
		sessionBits,
		sessionCanSeeSettings,
		sessionHasAnyPermission,
		sessionHasPermission,
		sessionPermissionLabels,
		sessionState,
		updateProfileDisplayName,
	} from "#lib/session.svelte";
	import { testEmail, testPush } from "#lib/api";
	import {
		ACCENT_PRESETS,
		accentState,
		confirmDialog,
		densityState,
		initAccent,
		initDensity,
		initTheme,
		initUrlTabSync,
		openHelp,
		openPalette,
		setAccent,
		setActiveTab,
		setDensity,
		setSoundEnabled,
		setTheme,
		showToast,
		soundEnabledState,
		tabState,
		themePrefState,
		themeState,
		type TabId,
	} from "#lib/ui.svelte";

	import Docs from "#tabs/Docs.svelte";
	import Billing from "#tabs/Billing.svelte";
	import Home from "#tabs/Home.svelte";
	import StatusPanel from "#tabs/home/StatusPanel.svelte";
	import Insights from "#tabs/Insights.svelte";
	import Keys from "#tabs/Keys.svelte";
	import Logs from "#tabs/Logs.svelte";
	import Settings from "#tabs/Settings.svelte";

	initTheme();
	initDensity();
	initAccent();
	initUrlTabSync();

	const publicPage = {
		"/pricing": "pricing",
		"/terms": "terms",
		"/privacy": "privacy",
		"/refund-policy": "refund",
		"/contact": "contact",
	}[location.pathname] as
		| "pricing"
		| "terms"
		| "privacy"
		| "refund"
		| "contact"
		| undefined;

	let homeRef: Home | undefined = $state();
	let loggingOut = $state(false);
	let loggingOutEverywhere = $state(false);
	let sessionsDialogOpen = $state(false);
	let accountMenuOpen = $state(false);
	let editingProfileName = $state(false);
	let profileNameDraft = $state("");
	let savingProfileName = $state(false);
	let sessionChecked = $state(false);
	let mobileStatusOpen = $state(false);
	let mobileSwipeStartX = $state<number | null>(null);

	const otherOnlineUsers = $derived(
		liveState.onlineUsers.filter((u) => u !== sessionState.sub),
	);

	function initials(name: string): string {
		return name.slice(0, 2).toUpperCase();
	}

	const myGrantedPermissions = $derived(sessionPermissionLabels());

	type NotifPermission = NotificationPermission | "unsupported";
	let notifPermission = $state<NotifPermission>(
		typeof Notification === "undefined"
			? "unsupported"
			: Notification.permission,
	);
	let pushEnabled = $state(false);
	let enablingPush = $state(false);
	let sendingTestPush = $state(false);
	let pushOnSuccess = $state(true);
	let pushOnFailure = $state(true);
	let pushOnAlerts = $state(true);
	let pushOnKeyExpiry = $state(true);
	let accountEmail = $state<string | undefined>(undefined);
	let notifyEmail = $state("");
	let sendingTestEmail = $state(false);
	let emailOnSuccess = $state(false);
	let emailOnFailure = $state(false);
	let emailOnAlerts = $state(false);
	let emailOnKeyExpiry = $state(false);

	void registerServiceWorker().then((registration) => {
		if (registration) initPwaUpdateWatcher(registration);
	});
	initInstallPromptWatcher();

	$effect(() => {
		if (!sessionState.loggedIn) return;
		if (pushSupported())
			void getExistingPushSubscription().then(
				(sub) => (pushEnabled = !!sub),
			);
		void fetchNotificationPrefs().then((prefs) => {
			pushOnSuccess = prefs.pushOnSuccess ?? true;
			pushOnFailure = prefs.pushOnFailure ?? true;
			pushOnAlerts = prefs.pushOnAlerts ?? true;
			pushOnKeyExpiry = prefs.pushOnKeyExpiry ?? true;
			accountEmail = prefs.accountEmail;
			notifyEmail = prefs.notifyEmail ?? "";
			emailOnSuccess = prefs.emailOnSuccess ?? false;
			emailOnFailure = prefs.emailOnFailure ?? false;
			emailOnAlerts = prefs.emailOnAlerts ?? false;
			emailOnKeyExpiry = prefs.emailOnKeyExpiry ?? false;
		});
	});

	async function togglePushOnSuccess(): Promise<void> {
		await pushNotificationPrefs({ pushOnSuccess });
	}

	async function togglePushOnFailure(): Promise<void> {
		await pushNotificationPrefs({ pushOnFailure });
	}

	async function togglePushOnAlerts(): Promise<void> {
		await pushNotificationPrefs({ pushOnAlerts });
	}

	async function togglePushOnKeyExpiry(): Promise<void> {
		await pushNotificationPrefs({ pushOnKeyExpiry });
	}

	async function toggleEmailOnSuccess(): Promise<void> {
		await pushNotificationPrefs({ emailOnSuccess });
	}

	async function toggleEmailOnFailure(): Promise<void> {
		await pushNotificationPrefs({ emailOnFailure });
	}

	async function toggleEmailOnAlerts(): Promise<void> {
		await pushNotificationPrefs({ emailOnAlerts });
	}

	async function toggleEmailOnKeyExpiry(): Promise<void> {
		await pushNotificationPrefs({ emailOnKeyExpiry });
	}

	async function saveNotifyEmail(): Promise<void> {
		await pushNotificationPrefs({ notifyEmail: notifyEmail.trim() });
	}

	async function sendTestEmail(): Promise<void> {
		sendingTestEmail = true;
		try {
			await testEmail();
		} finally {
			sendingTestEmail = false;
		}
	}

	async function enableNotifications(): Promise<void> {
		if (typeof Notification === "undefined") return;
		notifPermission = await Notification.requestPermission();
		if (notifPermission !== "granted" || !pushSupported()) return;
		enablingPush = true;
		try {
			pushEnabled = await enablePush();
		} catch {
			showToast(
				"Couldn't enable push notifications - try again",
				"error",
			);
		} finally {
			enablingPush = false;
		}
	}

	async function disableNotifications(): Promise<void> {
		enablingPush = true;
		try {
			await disablePush();
			pushEnabled = false;
		} finally {
			enablingPush = false;
		}
	}

	async function sendTestPush(): Promise<void> {
		sendingTestPush = true;
		try {
			await testPush();
		} finally {
			sendingTestPush = false;
		}
	}

	const TABS: { id: TabId; label: string; requires?: bigint[] }[] = [
		{ id: "home", label: "Home" },
		{ id: "billing", label: "Plans" },
		{
			id: "keys",
			label: "API Keys",
			requires: [
				PermissionFlag.requestApiKeys,
				PermissionFlag.createApiKeys,
				PermissionFlag.viewApiKeys,
				PermissionFlag.manageApiKeys,
			],
		},
		{ id: "logs", label: "Logs", requires: [PermissionFlag.viewLogs] },
		{ id: "insights", label: "Insights" },
		{ id: "docs", label: "Docs" },
		{ id: "settings", label: "Settings" },
	];

	const visibleTabs = $derived(
		TABS.filter((t) => {
			if (t.id === "settings") return sessionCanSeeSettings();
			return !t.requires || sessionHasAnyPermission(t.requires);
		}),
	);

	const TAB_ICON: Record<TabId, typeof HomeIcon> = {
		home: HomeIcon,
		billing: Wallet,
		keys: KeyRound,
		logs: ScrollText,
		insights: BarChart3,
		docs: BookOpen,
		settings: SettingsIcon,
	};

	async function doLogout(): Promise<void> {
		loggingOut = true;
		try {
			await logout();
		} finally {
			loggingOut = false;
		}
	}

	async function doLogoutEverywhere(): Promise<void> {
		if (
			!(await confirmDialog(
				"Sign out every device and browser signed in as you, including this one?",
				{ confirmLabel: "Log out everywhere" },
			))
		)
			return;
		loggingOutEverywhere = true;
		try {
			await logoutEverywhere();
		} finally {
			loggingOutEverywhere = false;
		}
	}

	function startEditingProfileName(): void {
		profileNameDraft = sessionState.displayName ?? "";
		editingProfileName = true;
	}

	async function saveProfileName(): Promise<void> {
		savingProfileName = true;
		try {
			const result = await updateProfileDisplayName(profileNameDraft);
			if (!result.ok) {
				showToast(
					result.error ?? "Could not update profile name.",
					"error",
				);
				return;
			}
			editingProfileName = false;
			showToast("Profile name updated.", "success");
		} finally {
			savingProfileName = false;
		}
	}

	$effect(() => {
		void refreshSession().finally(() => {
			sessionChecked = true;
		});
	});

	$effect(() => {
		if (sessionState.loggedIn) connectLive();
		else disconnectLive();
	});

	$effect(() => {
		if (
			sessionState.loggedIn &&
			!visibleTabs.some((t) => t.id === tabState.active)
		)
			setActiveTab("home");
	});

	const BASE_TITLE = "dkrypt";

	$effect(() => {
		if (publicPage) {
			const title = {
				pricing: "Pricing",
				terms: "Terms of Service",
				privacy: "Privacy Notice",
				refund: "Refund Policy",
				contact: "Contact",
			}[publicPage];
			document.title = `${title} · ${BASE_TITLE}`;
			return;
		}
		if (!sessionState.loggedIn) {
			document.title = BASE_TITLE;
			return;
		}
		const active = liveState.overview?.activeJobs.length ?? 0;
		const failed = myDecryptsState.items.filter(
			(d) => d.status === "failed",
		).length;
		const count = active + failed;
		document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
	});

	const TAB_JUMP_KEYS: Record<string, TabId> = {
		h: "home",
		b: "billing",
		k: "keys",
		l: "logs",
		i: "insights",
		d: "docs",
		s: "settings",
	};
	let awaitingTabJump = $state(false);
	let tabJumpTimer: ReturnType<typeof setTimeout> | undefined;

	function onKeydown(e: KeyboardEvent): void {
		const typingInField = ["INPUT", "TEXTAREA", "SELECT"].includes(
			(document.activeElement as HTMLElement)?.tagName ?? "",
		);
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			openPalette();
			return;
		}
		if (awaitingTabJump) {
			awaitingTabJump = false;
			clearTimeout(tabJumpTimer);
			const target = TAB_JUMP_KEYS[e.key.toLowerCase()];
			if (target && visibleTabs.some((t) => t.id === target)) {
				e.preventDefault();
				setActiveTab(target);
			}
			return;
		}
		if (e.key === "g" && !typingInField) {
			e.preventDefault();
			awaitingTabJump = true;
			tabJumpTimer = setTimeout(() => (awaitingTabJump = false), 900);
			return;
		}
		if (e.key === "/" && !typingInField && tabState.active === "home") {
			e.preventDefault();
			homeRef?.focusSearch();
			return;
		}
		if (e.key === "b" && !typingInField && tabState.active === "home") {
			e.preventDefault();
			homeRef?.openBatch();
			return;
		}
		if (e.key === "?" && !typingInField) {
			e.preventDefault();
			openHelp();
		}
	}

	function onMobilePointerDown(event: PointerEvent): void {
		if (window.innerWidth >= 1024) return;
		mobileSwipeStartX = event.clientX;
	}

	function onMobilePointerUp(event: PointerEvent): void {
		if (window.innerWidth >= 1024 || mobileSwipeStartX === null) return;
		const distance = event.clientX - mobileSwipeStartX;
		if (!mobileStatusOpen && mobileSwipeStartX >= window.innerWidth - 32 && distance < -48) mobileStatusOpen = true;
		if (mobileStatusOpen && distance > 64) mobileStatusOpen = false;
		mobileSwipeStartX = null;
	}

	const THEME_CYCLE = ["dark", "light", "auto"] as const;

	function cycleTheme(): void {
		const next =
			THEME_CYCLE[
				(THEME_CYCLE.indexOf(themePrefState.value) + 1) %
					THEME_CYCLE.length
			];
		setTheme(next);
		void pushThemePref(next);
	}

	function toggleDensity(): void {
		const next =
			densityState.value === "compact" ? "comfortable" : "compact";
		setDensity(next);
		void pushDensityPref(next);
	}

	function chooseAccent(id: string): void {
		setAccent(id);
		void pushAccentPref(id);
	}

	function toggleSound(): void {
		const next = !soundEnabledState.value;
		setSoundEnabled(next);
		void pushSoundPref(next);
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onMobilePointerDown} onpointerup={onMobilePointerUp} />

<Toaster theme={themeState.value} richColors position="bottom-right" />

{#if publicPage === "pricing"}
	<PublicPricing />
{:else if publicPage === "terms"}
	<LegalPage document="terms" />
{:else if publicPage === "privacy"}
	<LegalPage document="privacy" />
{:else if publicPage === "refund"}
	<LegalPage document="refund" />
{:else if publicPage === "contact"}
	<ContactPage />
{:else if !sessionChecked}
	<div class="min-h-screen"></div>
{:else if !sessionState.loggedIn}
	<Login />
{:else}
	<div class="min-h-screen">
		<MaintenanceBanner />
		<header
			class="glass-topbar sticky top-0 z-30 flex flex-wrap items-center gap-3 px-3 py-3 sm:px-5 lg:flex-nowrap xl:px-6"
		>
			<div class="flex items-center gap-3">
				<Lock class="brand-mark" aria-hidden="true" />
				<h1 class="text-[15px] font-semibold tracking-tight">dkrypt</h1>
			</div>
			<nav
				class="glass-nav order-3 hidden w-full items-center justify-center gap-1 p-1 lg:order-none lg:flex lg:w-auto lg:flex-1"
				aria-label="Primary"
			>
				{#each visibleTabs as t (t.id)}
					{@const Icon = TAB_ICON[t.id]}
					<button
						type="button"
						class={cn(
							"glass-nav-item flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap",
							tabState.active === t.id ? "is-active" : "",
						)}
						onclick={() => setActiveTab(t.id)}
						aria-current={tabState.active === t.id
							? "page"
							: undefined}
					>
						<Icon class="h-3.5 w-3.5" />
						{t.label}
					</button>
				{/each}
			</nav>
			<div class="flex items-center gap-2.5">
				<HeaderOnlineUsers />
				<a
					href={KOFI_URL}
					target="_blank"
					rel="noopener noreferrer"
					class={buttonVariants("secondary", "icon")}
					aria-label="Support on Ko-fi"
					title="Support on Ko-fi"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="currentColor"
						aria-hidden="true"
					>
						<path
							d="M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298"
						/>
					</svg>
				</a>
				<Button
					variant="secondary"
					size="icon"
					onclick={cycleTheme}
					aria-label="Theme: {themePrefState.value} (click to cycle)"
					title="Theme: {themePrefState.value} (click to cycle)"
				>
					{#if themePrefState.value === "auto"}
						<Monitor class="h-4 w-4" />
					{:else if themePrefState.value === "light"}
						<Sun class="h-4 w-4" />
					{:else}
						<Moon class="h-4 w-4" />
					{/if}
				</Button>
				<Button
					variant="secondary"
					size="icon"
					onclick={toggleDensity}
					aria-label="Toggle compact table rows"
					title={densityState.value === "compact"
						? "Switch to comfortable rows"
						: "Switch to compact rows"}
				>
					{#if densityState.value === "compact"}
						<Rows2 class="h-4 w-4" />
					{:else}
						<Rows3 class="h-4 w-4" />
					{/if}
				</Button>
				<Button
					variant="secondary"
					size="icon"
					onclick={openPalette}
					aria-label="Open command menu"
					title="Command menu (⌘/Ctrl K)"
				>
					<Command class="h-4 w-4" />
				</Button>
				<WhatsNewButton />
				<NotificationBell />
				<DropdownMenu.Root bind:open={accountMenuOpen}>
					<DropdownMenu.Trigger
						class="border-border hover:border-accent relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-full border"
						aria-label="Account menu"
						title={sessionState.displayName ?? sessionState.sub}
					>
						{#if sessionState.avatarUrl}
							<img
								src={sessionState.avatarUrl}
								alt=""
								class="h-full w-full object-cover"
							/>
						{:else}
							<div
								class="bg-panel-muted text-muted flex h-full w-full items-center justify-center text-[11px] font-medium"
							>
								{initials(
									sessionState.displayName ??
										sessionState.sub ??
										"",
								)}
							</div>
						{/if}
						{#if otherOnlineUsers.length > 0}
							<span
								class="bg-ok border-panel absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2"
							></span>
						{/if}
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
					<DropdownMenu.Content
							class="border-border bg-panel z-50 w-72 rounded-xl border p-3 shadow-2xl max-sm:!fixed max-sm:!top-14 max-sm:!right-2 max-sm:!left-auto max-sm:!w-[min(18rem,calc(100vw-1rem))] max-sm:!transform-none"
							sideOffset={8}
							align="end"
						>
							{#if editingProfileName}
								<form
									class="mb-3 flex items-center gap-1.5"
									onsubmit={(event) => {
										event.preventDefault();
										void saveProfileName();
									}}
								>
									<Input
										aria-label="Profile name"
										maxlength={64}
										bind:value={profileNameDraft}
										class="h-8"
										autofocus
									/>
									<Button
										size="sm"
										type="submit"
										loading={savingProfileName}>Save</Button
									>
									<Button
										size="sm"
										type="button"
										variant="secondary"
										onclick={() =>
											(editingProfileName = false)}
										>Cancel</Button
									>
								</form>
							{:else}
								<div class="mb-1 flex items-center gap-1.5">
									<div
										class="min-w-0 flex-1 truncate text-sm font-medium"
									>
										{sessionState.displayName ??
											sessionState.sub}
									</div>
									{#if sessionState.sub !== "root"}
										<Button
											variant="ghost"
											size="icon"
											class="h-7 w-7"
											onclick={startEditingProfileName}
											aria-label="Edit profile name"
											title="Edit profile name"
										>
											<Pencil class="h-3.5 w-3.5" />
										</Button>
									{/if}
								</div>
								{#if sessionState.displayName && sessionState.displayName !== sessionState.sub}
									<div
										class="mb-1 truncate text-xs text-muted"
									>
										{sessionState.sub}
									</div>
								{/if}
							{/if}
							<div class="mb-3 text-xs text-muted">
								{permissionsSummary(sessionBits())}
							</div>
							{#if sessionState.identities?.length}
								<div class="mb-3 flex flex-col gap-1.5">
									{#each sessionState.identities as identity (`${identity.provider}:${identity.username}`)}
										<div
											class="flex min-w-0 items-center gap-2 text-xs text-muted"
										>
											{#if identity.avatarUrl}
												<img
													src={identity.avatarUrl}
													alt=""
													class="h-5 w-5 shrink-0 rounded-full object-cover"
												/>
											{/if}
											<span class="font-medium text-text"
												>{identity.provider === "github"
													? "GitHub"
													: "Discord"}</span
											>
											<span class="truncate"
												>{identity.displayName} · @{identity.username}</span
											>
										</div>
									{/each}
								</div>
							{/if}
							{#if myGrantedPermissions.length > 0}
								<div class="mb-3 flex flex-wrap gap-1.5">
									{#each myGrantedPermissions as label (label)}
										<Badge variant="default">{label}</Badge>
									{/each}
								</div>
							{/if}

							{#if otherOnlineUsers.length > 0}
								<div class="border-border mb-3 border-t pt-3">
									<div class="mb-1.5 text-[11px] text-muted">
										{otherOnlineUsers.length} other{otherOnlineUsers.length ===
										1
											? ""
											: "s"} online
									</div>
									<div class="flex flex-wrap gap-1">
										{#each otherOnlineUsers as u (u)}
											<Badge variant="secondary" title={u}
												>{u}</Badge
											>
										{/each}
									</div>
								</div>
							{/if}

							<div class="border-border mb-3 border-t pt-3">
								<div
									class="mb-1.5 flex items-center justify-between gap-3"
								>
									<div class="text-[13px]">
										Job-completion sound
									</div>
									<Button
										variant="secondary"
										size="icon"
										onclick={toggleSound}
										aria-label="Toggle job-completion sound"
										title={soundEnabledState.value
											? "Sound on - click to mute"
											: "Sound off - click to enable"}
									>
										{#if soundEnabledState.value}
											<Volume2 class="h-4 w-4" />
										{:else}
											<VolumeX class="h-4 w-4" />
										{/if}
									</Button>
								</div>
								<div class="mb-1.5 text-[11px] text-muted">
									Accent color
								</div>
								<div class="flex flex-wrap gap-1.5">
									{#each ACCENT_PRESETS as preset (preset.id)}
										<button
											type="button"
											class="h-5 w-5 cursor-pointer rounded-full border-2"
											style="background-color: {themeState.value ===
											'light'
												? preset.light
												: preset.dark}; border-color: {accentState.value ===
											preset.id
												? 'var(--color-text)'
												: 'transparent'};"
											onclick={() =>
												chooseAccent(preset.id)}
											aria-label="Accent: {preset.label}"
											title={preset.label}
										></button>
									{/each}
								</div>
							</div>

							<div class="border-border mb-3 border-t pt-3">
								<div
									class="flex items-center justify-between gap-3"
								>
									<div class="text-[13px]">Notifications</div>
									{#if notifPermission === "granted" && pushEnabled}
										<Button
											size="sm"
											variant="secondary"
											loading={enablingPush}
											onclick={disableNotifications}
											>Disable push</Button
										>
									{:else if notifPermission === "denied"}
										<Badge
											variant="destructive"
											title="Blocked by your browser - check site settings"
											>Push blocked</Badge
										>
									{:else if notifPermission !== "unsupported"}
										<Button
											size="sm"
											variant="secondary"
											loading={enablingPush}
											onclick={enableNotifications}
											>Enable push</Button
										>
									{/if}
								</div>

								<Input
									type="email"
									class="mt-2 h-8 text-xs"
									placeholder={accountEmail ??
										"Email address"}
									bind:value={notifyEmail}
									onblur={saveNotifyEmail}
								/>

								<div
									class="mt-3 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs text-muted"
								>
									<div></div>
									<div class="text-center">Push</div>
									<div class="text-center">Email</div>

									<div>Successful decrypts</div>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={pushOnSuccess}
										onchange={togglePushOnSuccess}
									/>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={emailOnSuccess}
										onchange={toggleEmailOnSuccess}
									/>

									<div>Failed decrypts</div>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={pushOnFailure}
										onchange={togglePushOnFailure}
									/>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={emailOnFailure}
										onchange={toggleEmailOnFailure}
									/>

									<div>Device/system alerts</div>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={pushOnAlerts}
										onchange={togglePushOnAlerts}
									/>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={emailOnAlerts}
										onchange={toggleEmailOnAlerts}
									/>

									<div>API key expiring soon</div>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={pushOnKeyExpiry}
										onchange={togglePushOnKeyExpiry}
									/>
									<input
										class="justify-self-center"
										type="checkbox"
										bind:checked={emailOnKeyExpiry}
										onchange={toggleEmailOnKeyExpiry}
									/>
								</div>

								<div class="mt-3 flex gap-2">
									{#if notifPermission === "granted" && pushEnabled}
										<Button
											size="sm"
											variant="secondary"
											loading={sendingTestPush}
											onclick={sendTestPush}
											>Test push</Button
										>
									{/if}
									<Button
										size="sm"
										variant="secondary"
										loading={sendingTestEmail}
										onclick={sendTestEmail}
										>Test email</Button
									>
								</div>
							</div>

							{#if pwaState.canInstall}
								<div class="border-border mb-3 border-t pt-3">
									<Button
										variant="secondary"
										size="sm"
										class="w-full justify-start"
										onclick={() => void promptPwaInstall()}
									>
										<Download class="h-3.5 w-3.5" />
										Install app
									</Button>
								</div>
							{/if}

							<div
								class="border-border flex flex-col gap-1.5 border-t pt-3"
							>
								<Button
									variant="secondary"
									size="sm"
									class="w-full justify-start"
									onclick={() => {
										accountMenuOpen = false;
										sessionsDialogOpen = true;
									}}
								>
									<Monitor class="h-3.5 w-3.5" />
									Manage sessions
								</Button>
								<Button
									variant="secondary"
									size="sm"
									class="w-full justify-start"
									loading={loggingOut}
									onclick={doLogout}
								>
									<LogOut class="h-3.5 w-3.5" />
									Log out
								</Button>
								<Button
									variant="destructive"
									size="sm"
									class="w-full"
									loading={loggingOutEverywhere}
									onclick={doLogoutEverywhere}
								>
									Log out everywhere
								</Button>
							</div>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
		</header>
		<main
			class="mx-auto max-w-[1760px] px-3 pt-4 pb-[calc(3.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:pt-5 lg:px-6 lg:pb-6"
		>
			<SessionExpiryBanner />
			<ConnectionBanner />
			<UpdateAvailableBanner />
			<SetupBanner />
			<div
				class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5"
			>
				<div class="workspace-content min-w-0">
					<div class:hidden={tabState.active !== "home"}>
						<Home bind:this={homeRef} />
					</div>
					<div class:hidden={tabState.active !== "billing"}>
						<Billing />
					</div>
					<div class:hidden={tabState.active !== "keys"}>
						<Keys />
					</div>
					{#if sessionHasPermission(PermissionFlag.viewLogs)}
						<div class:hidden={tabState.active !== "logs"}>
							<Logs />
						</div>
					{/if}
					<div class:hidden={tabState.active !== "insights"}>
						<Insights />
					</div>
					<div class:hidden={tabState.active !== "docs"}>
						<Docs />
					</div>
					{#if sessionCanSeeSettings()}
						<div class:hidden={tabState.active !== "settings"}>
							<Settings />
						</div>
					{/if}
				</div>
				<div class="hidden min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:flex">
					<StatusPanel />
				</div>
			</div>
		</main>
		<button
			type="button"
			class="glass-status-pull fixed top-1/2 right-0 z-40 flex h-20 w-7 -translate-y-1/2 items-center justify-center rounded-l-xl lg:hidden"
			onclick={() => (mobileStatusOpen = true)}
			aria-label="Open status drawer"
		>
			<PanelRightOpen class="h-4 w-4" />
		</button>
		{#if mobileStatusOpen}
			<button
				type="button"
				class="fixed inset-0 z-40 bg-black/35 lg:hidden"
				onclick={() => (mobileStatusOpen = false)}
				aria-label="Close status drawer"
			></button>
		{/if}
		<aside
			class={cn(
				"fixed top-0 right-0 z-50 h-[100dvh] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto border-l border-border bg-panel p-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-2xl transition-transform duration-200 lg:hidden",
				mobileStatusOpen ? "translate-x-0" : "translate-x-full",
			)}
			aria-label="Status drawer"
			aria-hidden={!mobileStatusOpen}
		>
			<div class="mb-3 flex items-center justify-between">
				<span class="text-sm font-semibold">Status</span>
				<Button size="sm" variant="secondary" onclick={() => (mobileStatusOpen = false)}>Close</Button>
			</div>
			<StatusPanel />
		</aside>
		<nav class="glass-mobile-nav mobile-primary-nav fixed z-40 flex overflow-x-auto p-1 lg:hidden" aria-label="Primary">
			{#each visibleTabs as t (t.id)}
				{@const Icon = TAB_ICON[t.id]}
				<button
					type="button"
					class={cn(
						"flex min-w-13 flex-1 cursor-pointer flex-col items-center gap-0.5 rounded-lg py-2 text-[10.5px] transition-colors",
						tabState.active === t.id ? "bg-accent/10 text-accent" : "text-muted hover:text-text",
					)}
					onclick={() => setActiveTab(t.id)}
					aria-current={tabState.active === t.id ? "page" : undefined}
				>
					<Icon class="h-5 w-5" />
					{t.label}
				</button>
			{/each}
		</nav>
	</div>
{/if}

<ConfirmModal />
<CommandPalette />
<ShortcutsHelp />
<OnboardingTour />
<SessionsDialog
	open={sessionsDialogOpen}
	onOpenChange={(v) => (sessionsDialogOpen = v)}
/>
