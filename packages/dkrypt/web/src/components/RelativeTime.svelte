<script lang="ts">
  import { fmtRelative, fmtTime } from '#lib/format.svelte';

  let { ms }: { ms?: number } = $props();
</script>

{#if ms}
  <span title={fmtTime(ms)}>{fmtRelative(ms)}</span>
{:else}
  <span>-</span>
{/if}
