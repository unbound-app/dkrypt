<script lang="ts">
	import { PackageSearch } from "lucide-svelte";
	import {
		cancelJob,
		artifactDownloadUrl,
		fetchJobStatus,
		queueDecrypt,
		queueTestFlightDecrypt,
		dashboardArtifactDownloadUrl,
	} from "#lib/api";
	import CopyButton from "#components/CopyButton.svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import { buttonVariants } from "#lib/components/ui/variants";
	import {
		addDecrypt,
		dismissDecrypt,
		highlightJobIdState,
		myDecryptsState,
		pushRecentBundleId,
		updateDecrypt,
		type TrackedDecrypt,
	} from "#lib/decrypts.svelte";
	import { notifyJobFinished } from "#lib/notifications";
	import { playChime, vibrateCompletion } from "#lib/sound";
	import { showToast, soundEnabledState } from "#lib/ui.svelte";

	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let retrying = $state<Set<string>>(new Set());

	async function poll(): Promise<void> {
		clearTimeout(pollTimer);
		if (document.hidden) return;
		const pending = myDecryptsState.items.filter(
			(d) => d.status !== "done" && d.status !== "failed",
		);
		if (pending.length === 0) return;

		for (const d of pending) {
			try {
				const data = await fetchJobStatus(d.id);
				if (
					d.status !== data.status &&
					(data.status === "done" || data.status === "failed")
				) {
					const label = d.versionLabel
						? `${d.trackName} (${d.versionLabel})`
						: d.trackName;
					const downloadUrl =
						data.status === "done" && data.artifactId
							? dashboardArtifactDownloadUrl(data.artifactId)
							: undefined;
					const message =
						data.status === "done"
							? downloadUrl
								? `${label} is ready to download.`
								: `${label} finished, but its artifact is unavailable.`
							: `${label} failed: ${data.error ?? "unknown error"}`;
					notifyJobFinished(
						data.status === "done"
							? "Decrypt finished"
							: "Decrypt failed",
						message,
						downloadUrl,
					);
					if (soundEnabledState.value) {
						playChime();
						vibrateCompletion(data.status === "done");
					}
				}
				updateDecrypt(d.id, {
					status: data.status,
					progress: data.progress,
					queue: data.queue,
					error: data.error,
					artifactId: data.artifactId,
					artifactUrl: data.artifactUrl,
				});
			} catch {}
		}

		pollTimer = setTimeout(poll, 2500);
	}

	function onVisibilityChange(): void {
		if (!document.hidden) void poll();
	}

	$effect(() => {
		void poll();
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			clearTimeout(pollTimer);
			document.removeEventListener(
				"visibilitychange",
				onVisibilityChange,
			);
		};
	});

	async function retry(d: TrackedDecrypt): Promise<void> {
		retrying = new Set(retrying).add(d.id);
		try {
			const { ok, data } = d.testflight
				? await queueTestFlightDecrypt(
						d.bundleId,
						d.testflight.appId,
						d.testflight.build,
					)
				: await queueDecrypt(
						d.bundleId,
						d.externalVersionId,
						d.versionLabel,
					);
			if (!ok) return;
			addDecrypt({
				id: data.id,
				bundleId: d.bundleId,
				trackName: d.trackName,
				versionLabel: d.versionLabel,
				externalVersionId: d.externalVersionId,
				testflight: d.testflight,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
				artifactId: data.artifactId,
				artifactUrl: data.artifactUrl,
			});
			pushRecentBundleId(d.bundleId);
			dismissDecrypt(d.id);
			showToast(
				`Queued ${d.trackName}${d.versionLabel ? ` (${d.versionLabel})` : ""}`,
				"success",
			);
		} finally {
			const next = new Set(retrying);
			next.delete(d.id);
			retrying = next;
		}
	}

	let cancelling = $state<Set<string>>(new Set());
	let copyingCurl = $state<Set<string>>(new Set());
	async function copyCurl(d: TrackedDecrypt): Promise<void> {
		copyingCurl = new Set(copyingCurl).add(d.id);
		try {
			const artifactUrl = d.artifactUrl ?? (d.artifactId ? artifactDownloadUrl(d.artifactId) : undefined);
			if (!artifactUrl) {
				showToast("This artifact is no longer available", "error");
				return;
			}
			const filename = `${d.bundleId}.ipa`;
			const url = new URL(artifactUrl, window.location.origin).toString();
			await navigator.clipboard.writeText(
				`curl -H "Authorization: Bearer <YOUR_API_KEY>" -o "${filename}" "${url}"`,
			);
			showToast("Copied authenticated curl command", "success");
		} catch {
			showToast(
				"Couldn't copy - your browser blocked clipboard access",
				"error",
			);
		} finally {
			const next = new Set(copyingCurl);
			next.delete(d.id);
			copyingCurl = next;
		}
	}

	async function cancel(d: TrackedDecrypt): Promise<void> {
		cancelling = new Set(cancelling).add(d.id);
		try {
			const { ok } = await cancelJob(d.id);
			if (ok) dismissDecrypt(d.id);
		} finally {
			const next = new Set(cancelling);
			next.delete(d.id);
			cancelling = next;
		}
	}

	function dismiss(d: TrackedDecrypt): void {
		dismissDecrypt(d.id);
		showToast("Dismissed", "success", {
			action: { label: "Undo", onClick: () => addDecrypt(d) },
		});
	}

	let highlightedId = $state<string | null>(null);

	$effect(() => {
		const id = highlightJobIdState.id;
		if (!id || !myDecryptsState.items.some((d) => d.id === id)) return;
		highlightedId = id;
		const row = document.querySelector(`[data-job-id="${CSS.escape(id)}"]`);
		row?.scrollIntoView({ behavior: "smooth", block: "center" });
		const timer = setTimeout(() => {
			highlightedId = null;
			if (highlightJobIdState.id === id) highlightJobIdState.id = null;
		}, 2000);
		return () => clearTimeout(timer);
	});

	const finishedCount = $derived(
		myDecryptsState.items.filter(
			(d) => d.status === "done" || d.status === "failed",
		).length,
	);

	$effect(() => {
		void ensureAppCatalog(
			myDecryptsState.items.map((entry) => entry.bundleId),
		);
	});

	let failedDetailsOpen = $state(false);
	let failedDetails = $state<{ title: string; message: string } | null>(null);

	function openFailedDetails(d: TrackedDecrypt): void {
		failedDetails = {
			title: d.versionLabel
				? `${appDisplayName(d.bundleId, d.trackName)} (${d.versionLabel})`
				: appDisplayName(d.bundleId, d.trackName),
			message:
				d.error ?? "No error details were captured for this failure.",
		};
		failedDetailsOpen = true;
	}

	function clearFinished(): void {
		for (const d of myDecryptsState.items) {
			if (d.status === "done" || d.status === "failed")
				dismissDecrypt(d.id);
		}
	}
</script>

<Card title="My requests">
	{#snippet headerExtra()}
		{#if finishedCount > 0}
			<Button size="sm" variant="secondary" onclick={clearFinished}
				>Clear finished ({finishedCount})</Button
			>
		{/if}
	{/snippet}
	{#if myDecryptsState.items.length === 0}
		<EmptyState icon={PackageSearch} message="Nothing queued yet." />
	{:else}
		<table class="responsive-table">
			<thead>
				<tr>
					<th>App</th>
					<th>Status</th>
					<th>Queued</th>
					<th>Job ID</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each myDecryptsState.items as d (d.id)}
					<tr
						data-job-id={d.id}
						class:job-highlight={d.id === highlightedId}
					>
						<td data-label="App" class="max-w-40 truncate">
							<div class="flex items-center justify-end gap-1.5">
								{#if appIconUrl(d.bundleId)}
									<img
										src={appIconUrl(d.bundleId)}
										alt=""
										class="h-4 w-4 shrink-0 rounded"
									/>
								{/if}
								<span title={d.bundleId}
									>{appDisplayName(
										d.bundleId,
										d.trackName,
									)}</span
								>
							</div>
							{#if d.versionLabel}
								<span class="text-muted text-xs"
									>({d.versionLabel})</span
								>
							{/if}
						</td>
						<td data-label="Status" class="min-w-0">
							<div
								class="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right"
							>
								{#if d.status === "done"}
									<Badge variant="success">done</Badge>
								{:else if d.status === "failed"}
									<Badge variant="destructive">failed</Badge>
								{:else if d.status === "running"}
									<Badge>running</Badge>
									<span class="min-w-0 break-words text-muted"
										>{d.progress ?? ""}</span
									>
								{:else}
									<Badge>queued</Badge>
									<span class="text-muted"
										>{d.queue
											? `position ${d.queue.position} of ${d.queue.total}`
											: ""}</span
									>
								{/if}
							</div>
						</td>
						<td data-label="Queued" class="text-muted"
							><RelativeTime ms={d.createdAt} /></td
						>
						<td data-label="Job ID">
								<div class="flex items-center gap-1.5">
									<code title={d.id}>{d.id.slice(0, 8)}</code>
									<CopyButton text={d.id} />
								</div>
						</td>
						<td data-label="Actions" class="mobile-actions">
							<div class="flex flex-wrap justify-end gap-1.5">
								{#if d.status === "done"}
									{#if d.artifactId}
										<a
											class={buttonVariants("default", "sm")}
											href={dashboardArtifactDownloadUrl(d.artifactId)}
											>Download</a
										>
										<Button
											size="sm"
											variant="secondary"
											loading={copyingCurl.has(d.id)}
											onclick={() => copyCurl(d)}
											>Copy curl</Button
										>
									{/if}
										<Button
											size="sm"
											variant="secondary"
											onclick={() => dismiss(d)}
											>Dismiss</Button
										>
									{:else if d.status === "failed"}
										<Button
											size="sm"
											loading={retrying.has(d.id)}
											onclick={() => retry(d)}>Retry</Button
										>
										<Button
											size="sm"
											variant="secondary"
											onclick={() => openFailedDetails(d)}
											>Error</Button
										>
										<Button
											size="sm"
											variant="secondary"
											onclick={() => dismiss(d)}
											>Dismiss</Button
										>
									{:else if d.status === "queued"}
										<Button
											size="sm"
											variant="destructive"
											loading={cancelling.has(d.id)}
											onclick={() => cancel(d)}>Cancel</Button
										>
										<Button
											size="sm"
											variant="secondary"
											onclick={() => dismiss(d)}
											>Dismiss</Button
										>
									{:else}
										<Button
											size="sm"
											variant="secondary"
											onclick={() => dismiss(d)}
											>Dismiss</Button
										>
								{/if}
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</Card>

<Dialog
	open={failedDetailsOpen}
	onOpenChange={(v) => (failedDetailsOpen = v)}
	class="max-w-md"
>
	<div class="mb-2 text-sm font-medium">
		{failedDetails?.title ?? "Failure details"}
	</div>
	<pre
		class="bg-panel-muted max-h-80 overflow-auto rounded-lg p-3 text-xs leading-5 whitespace-pre-wrap">{failedDetails?.message ??
			""}</pre>
</Dialog>
