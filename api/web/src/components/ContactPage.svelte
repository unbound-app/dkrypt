<script lang="ts">
  import Card from '../lib/components/ui/Card.svelte';
  import PublicPageFooter from './PublicPageFooter.svelte';
  import PublicPageHeader from './PublicPageHeader.svelte';
</script>

<div class="min-h-screen">
  <PublicPageHeader />
  <main class="mx-auto max-w-3xl px-5 py-12">
    <div class="mb-8">
      <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Support</div>
      <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">Contact dkrypt</h1>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <Card>
        <h2 class="text-base font-semibold">Product and privacy support</h2>
        <p class="mt-2 text-sm leading-6 text-muted">
          For account, service, or privacy questions, use a private contact option listed on the
          <a class="text-accent" href="https://github.com/castdrian" target="_blank" rel="noopener noreferrer">maintainer profile</a>.
        </p>
      </Card>
      <Card>
        <h2 class="text-base font-semibold">Billing and refunds</h2>
        <p class="mt-2 text-sm leading-6 text-muted">
          Use the manage-subscription link in your purchase receipt or visit
          <a class="text-accent" href="https://paddle.net" target="_blank" rel="noopener noreferrer">billing support</a>.
        </p>
      </Card>
      <Card>
        <h2 class="text-base font-semibold">Security reports</h2>
        <p class="mt-2 text-sm leading-6 text-muted">
          Do not post credentials or vulnerability details publicly. Use a private contact option listed on the
          <a class="text-accent" href="https://github.com/castdrian" target="_blank" rel="noopener noreferrer">maintainer profile</a>.
        </p>
      </Card>
    </div>
  </main>
  <PublicPageFooter />
</div>
