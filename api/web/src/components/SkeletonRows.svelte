<script lang="ts">
  let { rows = 3, colspan = 4 }: { rows?: number; colspan?: number } = $props();
</script>

{#each Array(rows) as _, i (i)}
  <tr>
    <td {colspan} class="py-2">
      <div class="skeleton bg-panel-muted h-3.5 w-full rounded"></div>
    </td>
  </tr>
{/each}
