<script lang="ts">
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Checkbox from "#lib/components/ui/Checkbox.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { disablePush, enablePush, getExistingPushSubscription, pushSupported } from "#lib/push";
import { fetchNotificationPrefs, pushNotificationPrefs, sessionState, type NotificationPrefs } from "#lib/session.svelte";
	import { showToast } from "#lib/ui.svelte";
	import { translateMessage, type MessageKey } from "#lib/messages";
	import type { InterfaceLanguage } from "#lib/locale";
	import { testEmail, testPush } from "#lib/api";

	let { interfaceLanguage }: { interfaceLanguage: InterfaceLanguage } = $props();

	const msg = (key: MessageKey) => translateMessage(key, interfaceLanguage);
	type NotificationPreferenceKey =
		| "pushOnSuccess"
		| "pushOnFailure"
		| "pushOnAlerts"
		| "pushOnKeyExpiry"
		| "emailOnSuccess"
		| "emailOnFailure"
		| "emailOnAlerts"
		| "emailOnKeyExpiry";
	type NotificationPreferenceValues = Required<
		Pick<NotificationPrefs, NotificationPreferenceKey>
	>;
	type NotificationPreferenceCategory = {
		label: MessageKey;
		pushKey: NotificationPreferenceKey;
		pushLabel: MessageKey;
		emailKey: NotificationPreferenceKey;
		emailLabel: MessageKey;
	};
	const notificationCategories: NotificationPreferenceCategory[] = [
		{
			label: "notifications.successfulDecrypts",
			pushKey: "pushOnSuccess",
			pushLabel: "notifications.pushSuccessfulDecrypts",
			emailKey: "emailOnSuccess",
			emailLabel: "notifications.emailSuccessfulDecrypts",
		},
		{
			label: "notifications.failedDecrypts",
			pushKey: "pushOnFailure",
			pushLabel: "notifications.pushFailedDecrypts",
			emailKey: "emailOnFailure",
			emailLabel: "notifications.emailFailedDecrypts",
		},
		{
			label: "notifications.deviceSystemAlerts",
			pushKey: "pushOnAlerts",
			pushLabel: "notifications.pushDeviceSystemAlerts",
			emailKey: "emailOnAlerts",
			emailLabel: "notifications.emailDeviceSystemAlerts",
		},
		{
			label: "notifications.apiKeyExpiring",
			pushKey: "pushOnKeyExpiry",
			pushLabel: "notifications.pushApiKeyExpiring",
			emailKey: "emailOnKeyExpiry",
			emailLabel: "notifications.emailApiKeyExpiring",
		},
	];
	function preferencesWithDefaults(
		prefs: NotificationPrefs,
	): NotificationPreferenceValues {
		return {
			pushOnSuccess: prefs.pushOnSuccess ?? true,
			pushOnFailure: prefs.pushOnFailure ?? true,
			pushOnAlerts: prefs.pushOnAlerts ?? true,
			pushOnKeyExpiry: prefs.pushOnKeyExpiry ?? true,
			emailOnSuccess: prefs.emailOnSuccess ?? false,
			emailOnFailure: prefs.emailOnFailure ?? false,
			emailOnAlerts: prefs.emailOnAlerts ?? false,
			emailOnKeyExpiry: prefs.emailOnKeyExpiry ?? false,
		};
	}
	type NotifPermission = NotificationPermission | "unsupported";
	let notifPermission = $state<NotifPermission>(
		typeof Notification === "undefined" ? "unsupported" : Notification.permission,
	);
	let pushEnabled = $state(false);
	let enablingPush = $state(false);
	let sendingTestPush = $state(false);
	let notificationPreferences = $state(preferencesWithDefaults({}));
	let accountEmail = $state<string | undefined>(undefined);
	let notifyEmail = $state("");
	let sendingTestEmail = $state(false);

	$effect(() => {
		if (!sessionState.loggedIn) return;
		if (pushSupported()) {
			void getExistingPushSubscription().then((subscription) => {
				pushEnabled = !!subscription;
			});
		}
		void fetchNotificationPrefs().then((prefs) => {
			notificationPreferences = preferencesWithDefaults(prefs);
			accountEmail = prefs.accountEmail;
			notifyEmail = prefs.notifyEmail ?? "";
		});
	});

	async function savePreference(
		key: NotificationPreferenceKey,
		value: boolean,
	): Promise<void> {
		notificationPreferences[key] = value;
		await pushNotificationPrefs({ [key]: value });
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
			showToast("Couldn't enable push notifications - try again", "error");
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
</script>

<section class="border-border mb-3 border-t pt-3" lang={interfaceLanguage} aria-label={msg("notifications.title")}>
	<div class="flex items-center justify-between gap-3">
		<div class="text-[13px]">{msg("notifications.title")}</div>
		{#if notifPermission === "granted" && pushEnabled}
			<Button size="sm" variant="secondary" loading={enablingPush} onclick={disableNotifications}>{msg("notifications.disablePush")}</Button>
		{:else if notifPermission === "denied"}
			<Badge variant="destructive" title={msg("notifications.browserBlockedTitle")}>{msg("notifications.pushBlocked")}</Badge>
		{:else if notifPermission !== "unsupported"}
			<Button size="sm" variant="secondary" loading={enablingPush} onclick={enableNotifications}>{msg("notifications.enablePush")}</Button>
		{/if}
	</div>

	<Input
		type="email"
		class="mt-2 h-8 text-xs"
		placeholder={accountEmail ?? msg("notifications.emailAddress")}
		bind:value={notifyEmail}
		onblur={saveNotifyEmail}
	/>

	<div class="mt-3 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs text-muted">
		<div></div>
		<div class="text-center">{msg("notifications.pushColumn")}</div>
		<div class="text-center">{msg("notifications.emailColumn")}</div>

		{#each notificationCategories as category (category.label)}
			<div>{msg(category.label)}</div>
			<Checkbox
				class="justify-self-center"
				checked={notificationPreferences[category.pushKey]}
				onCheckedChange={(value) => savePreference(category.pushKey, value)}
				aria-label={msg(category.pushLabel)}
			/>
			<Checkbox
				class="justify-self-center"
				checked={notificationPreferences[category.emailKey]}
				onCheckedChange={(value) => savePreference(category.emailKey, value)}
				aria-label={msg(category.emailLabel)}
			/>
		{/each}
	</div>

	<div class="mt-3 flex gap-2">
		{#if notifPermission === "granted" && pushEnabled}
			<Button size="sm" variant="secondary" loading={sendingTestPush} onclick={sendTestPush}>{msg("notifications.testPush")}</Button>
		{/if}
		<Button size="sm" variant="secondary" loading={sendingTestEmail} onclick={sendTestEmail}>{msg("notifications.testEmail")}</Button>
	</div>
</section>
