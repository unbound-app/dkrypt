<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
</script>

<section class="flex min-h-[calc(100dvh-12rem)] w-full flex-col gap-4">
  <header class="flex flex-wrap items-center justify-between gap-3">
    <div class="space-y-1">
      <h1 class="text-base font-semibold">API documentation</h1>
      <p class="text-muted text-sm">Browse the dkrypt API endpoints and schemas.</p>
    </div>
    <a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary')}>
      <ExternalLink class="h-4 w-4" />Open standalone reference
    </a>
  </header>
  <iframe
    title="dkrypt API reference"
    src="/reference/"
    loading="lazy"
    class="min-h-[34rem] w-full flex-1 rounded-xl border bg-background"
  ></iframe>
</section>
