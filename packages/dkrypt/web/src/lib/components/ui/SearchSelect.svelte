<script lang="ts">
	import { Combobox } from "bits-ui";
	import { Check, ChevronDown } from "lucide-svelte";
	import { fmtNumber } from "#lib/format.svelte";
	import { cn } from "#lib/utils";

	interface Item {
		value: string;
		label: string;
	}

	interface Props {
		items: Item[];
		value: string;
		onValueChange?: (value: string) => void;
		placeholder?: string;
		label?: string;
		class?: string;
		id?: string;
		disabled?: boolean;
		maxVisible?: number;
	}

	let {
		items,
		value = $bindable(),
		onValueChange,
		placeholder = "Search…",
		label,
		class: className,
		id,
		disabled = false,
		maxVisible = 50,
	}: Props = $props();

	let open = $state(false);
	let query = $state("");
	const generatedId = $props.id();
	const contentId = $derived(`${id ?? generatedId}-listbox`);

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q
			? items.filter((i) => i.label.toLowerCase().includes(q))
			: items;
	});
	const visible = $derived(filtered.slice(0, maxVisible));
	const hiddenCount = $derived(filtered.length - visible.length);

	$effect(() => {
		if (!open) query = items.find((i) => i.value === value)?.label ?? "";
	});
</script>

<Combobox.Root
	type="single"
	bind:value
	bind:open
	{items}
	{onValueChange}
	{disabled}
	inputValue={query}
>
	<div class="relative">
		<Combobox.Input
			{id}
			data-slot="combobox-input"
			aria-controls={open ? contentId : undefined}
			{placeholder}
			onfocus={() => (open = true)}
			oninput={(e: Event) => {
				query = (e.currentTarget as HTMLInputElement).value;
				open = true;
			}}
			class={cn(
				"border-input bg-background ring-offset-background flex h-9 w-full items-center rounded-md border px-3 pr-8 text-sm text-foreground shadow-sm focus:ring-ring focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
		/>
		<ChevronDown
			class="text-muted pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2"
		/>
	</div>
	<Combobox.Portal>
		<Combobox.Content
			id={contentId}
			aria-label={label ?? placeholder}
			data-slot="combobox-content"
			class="border-border bg-popover text-popover-foreground z-50 overflow-hidden rounded-md border p-1 shadow-md"
			style="width: var(--bits-floating-anchor-width); min-width: max(var(--bits-floating-anchor-width), 12rem);"
			sideOffset={4}
		>
			<Combobox.Viewport class="max-h-64 overflow-y-auto p-1">
				{#each visible as item (item.value)}
					<Combobox.Item
						value={item.value}
						label={item.label}
						class="data-highlighted:bg-secondary data-highlighted:ring-ring flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm text-foreground data-highlighted:ring-1"
					>
						{#snippet children({ selected })}
							<span class="truncate">{item.label}</span>
							{#if selected}<Check
									class="text-primary h-4 w-4 shrink-0"
								/>{/if}
						{/snippet}
					</Combobox.Item>
				{/each}
				{#if visible.length === 0}
					<div class="px-2 py-2 text-xs text-muted">No matches.</div>
				{:else if hiddenCount > 0}
					<div class="px-2 py-1.5 text-[11px] text-muted">
						{fmtNumber(hiddenCount, 0)} more - keep typing to narrow it down
					</div>
				{/if}
			</Combobox.Viewport>
		</Combobox.Content>
	</Combobox.Portal>
</Combobox.Root>
