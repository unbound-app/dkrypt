<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
</script>

<section class="flex flex-col gap-4">
  <header class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-base font-semibold">API documentation</h1>
      <p class="text-muted text-sm">Browse API endpoints and schemas.</p>
    </div>
    <a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary')}>
      <ExternalLink class="h-4 w-4" />Open in new tab
    </a>
  </header>
  <iframe
    title="dkrypt API reference"
    src="/reference/"
    loading="lazy"
    class="min-h-[75vh] w-full rounded-xl border bg-card"
  ></iframe>
</section>
