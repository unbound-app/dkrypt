<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { promptState, resolvePrompt } from '#lib/ui.svelte';
</script>

<Dialog open={promptState.open} title={promptState.message} onOpenChange={(open) => !open && resolvePrompt(null)}>
  <form onsubmit={(event) => { event.preventDefault(); resolvePrompt(promptState.value); }}>
    <label for="dashboard-prompt-input" class="block text-sm font-medium">{promptState.message}</label>
    <input id="dashboard-prompt-input" type={promptState.type} class="mt-3 min-h-10 w-full rounded-md border border-border bg-background px-3 text-sm" bind:value={promptState.value} autocomplete="off" />
    <div class="mt-4 flex justify-end gap-2">
      <Button type="button" variant="secondary" onclick={() => resolvePrompt(null)}>Cancel</Button>
      <Button type="submit">{promptState.confirmLabel}</Button>
    </div>
  </form>
</Dialog>
