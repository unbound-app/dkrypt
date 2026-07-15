<script lang="ts">
  import Button from '../lib/components/ui/Button.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import { confirmState, resolveConfirm } from '../lib/ui.svelte';
</script>

<Dialog open={confirmState.open} onOpenChange={(open) => !open && resolveConfirm(false)}>
  <div class="text-sm text-text">{confirmState.message}</div>
  <div class="mt-4 flex justify-end gap-2">
    <Button variant="secondary" onclick={() => resolveConfirm(false)}>Cancel</Button>
    <Button variant="destructive" onclick={() => resolveConfirm(true)}>Confirm</Button>
  </div>
</Dialog>
