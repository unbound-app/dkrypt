<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
</script>

<section class="flex min-h-[70vh] items-center justify-center px-4 py-12">
  <div class="flex w-full max-w-lg flex-col items-center gap-4 rounded-2xl border bg-card p-8 text-center">
    <div>
      <h1 class="text-base font-semibold">API documentation</h1>
      <p class="mt-2 text-muted text-sm">Open the interactive API reference in a separate tab to avoid browser embedding restrictions.</p>
    </div>
    <a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary')}>
      <ExternalLink class="h-4 w-4" />Open API reference
    </a>
  </div>
</section>
