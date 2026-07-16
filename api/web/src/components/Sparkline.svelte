<script lang="ts">
  interface Point {
    label: string;
    value: number;
  }

  let { data, width = 140, height = 28, ariaLabel }: { data: Point[]; width?: number; height?: number; ariaLabel?: string } = $props();

  const max = $derived(Math.max(1, ...data.map((d) => d.value)));
  const barWidth = $derived(width / Math.max(1, data.length));
</script>

<svg {width} {height} viewBox="0 0 {width} {height}" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel} aria-hidden={ariaLabel ? undefined : 'true'}>
  {#each data as d, i (i)}
    {@const h = Math.max(1.5, (d.value / max) * height)}
    <rect x={i * barWidth + 0.5} y={height - h} width={Math.max(1, barWidth - 1)} height={h} rx="1" class="fill-accent" opacity={d.value === 0 ? 0.2 : 1}>
      <title>{d.label}: {d.value}</title>
    </rect>
  {/each}
</svg>
