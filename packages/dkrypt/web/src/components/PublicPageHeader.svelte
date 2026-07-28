<script lang="ts">
  import LegalLinks from '#components/LegalLinks.svelte';
</script>

<header class="border-border border-b">
  <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-4">
    <a href="/" class="text-base font-semibold text-text no-underline">dkrypt</a>
    <LegalLinks />
    <a href="/#sign-in" class="bg-accent rounded-md px-4 py-2 text-sm font-medium text-white no-underline hover:opacity-90">
      Sign in
    </a>
  </div>
</header>
