<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
</script>

<Card class="flex min-h-64 flex-col items-start justify-center gap-3 p-6">
  <h1 class="text-base font-semibold">API documentation</h1>
  <p class="text-muted max-w-xl text-sm">Some browser previews block embedded pages. Open the reference in the full window, or choose a new tab.</p>
  <a href="/reference/" target="_top" rel="noopener noreferrer" class={buttonVariants('default')}>
    <ExternalLink class="h-4 w-4" />Open API reference
  </a>
  <a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary')}>
    <ExternalLink class="h-4 w-4" />Open in a new tab
  </a>
</Card>
