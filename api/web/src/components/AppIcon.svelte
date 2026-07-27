<script lang="ts">
	let {
		bundleId,
		src,
		label,
		class: className = "",
	}: { bundleId: string; src?: string; label?: string; class?: string } = $props();

	let failed = $state(false);

	$effect(() => {
		void src;
		failed = false;
	});

	function initials(value: string): string {
		const words = value.split(/[.\s_-]+/).filter(Boolean);
		return (words.at(-1)?.slice(0, 2) ?? "AP").toUpperCase();
	}

	function color(value: string): string {
		let hash = 0;
		for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
		return `hsl(${hash % 360} 52% 43%)`;
	}
</script>

{#if src && !failed}
	<img class={`shrink-0 rounded-[22%] ${className}`} src={src} alt="" onerror={() => (failed = true)} />
{:else}
	<span
		class={`inline-flex shrink-0 items-center justify-center rounded-[22%] font-semibold text-white ${className}`}
		style={`background:${color(bundleId)}`}
		aria-label={label ?? bundleId}
	>
		{initials(label ?? bundleId)}
	</span>
{/if}
