<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
</script>

<section class="flex min-h-64 flex-col items-start justify-center gap-3 rounded-xl border bg-card p-6">
  <h1 class="text-base font-semibold">API documentation</h1>
  <p class="text-muted max-w-xl text-sm">Browse API endpoints and schemas in the standalone reference.</p>
  <a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary')}>
    <ExternalLink class="h-4 w-4" />Open API reference
  </a>
</section>
