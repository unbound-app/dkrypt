<script lang="ts">
  import { Check, Gauge, KeyRound, X, Zap } from 'lucide-svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import PublicPageFooter from './PublicPageFooter.svelte';
  import PublicPageHeader from './PublicPageHeader.svelte';

  const plans = [
    {
      name: 'Regular',
      price: '€5',
      description: 'Dashboard decrypt access with standard queue priority.',
      api: false,
      priority: false,
    },
    {
      name: 'Priority',
      price: '€10',
      description: 'Dashboard decrypt access with high queue priority.',
      api: false,
      priority: true,
    },
    {
      name: 'API',
      price: '€15',
      description: 'Dashboard decrypts and API key access with standard priority.',
      api: true,
      priority: false,
    },
    {
      name: 'Priority API',
      price: '€20',
      description: 'Dashboard decrypts and API key access with high priority.',
      api: true,
      priority: true,
    },
  ];
</script>

<div class="min-h-screen">
  <PublicPageHeader />
  <main class="mx-auto max-w-6xl px-5 py-12">
    <div class="mx-auto mb-10 max-w-3xl text-center">
      <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Simple monthly access</div>
      <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">Choose a dkrypt plan</h1>
      <p class="mt-4 text-sm leading-6 text-muted">
        Every account starts with free viewer-only access. Subscribe when you need authorized decrypt processing, API access, or higher queue priority.
      </p>
    </div>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {#each plans as plan (plan.name)}
        <Card class={plan.name === 'Priority API' ? 'border-accent shadow-lg shadow-accent/10' : ''}>
          <div class="flex h-full min-h-72 flex-col">
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold">{plan.name}</h2>
                <p class="mt-1 text-sm text-muted">{plan.description}</p>
              </div>
              {#if plan.priority}
                <Zap class="h-5 w-5 shrink-0 text-accent" />
              {:else if plan.api}
                <KeyRound class="h-5 w-5 shrink-0 text-accent" />
              {:else}
                <Gauge class="h-5 w-5 shrink-0 text-accent" />
              {/if}
            </div>

            <div class="mb-5">
              <span class="text-3xl font-semibold">{plan.price}</span>
              <span class="text-sm text-muted">/month</span>
            </div>

            <div class="mb-6 flex flex-1 flex-col gap-2 text-sm">
              <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> Dashboard decrypts</div>
              {#if plan.api}
                <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> API key access</div>
              {:else}
                <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> API key access</div>
              {/if}
              {#if plan.priority}
                <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> High queue priority</div>
              {:else}
                <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> High queue priority</div>
              {/if}
            </div>

            <a
              href="/#sign-in"
              class="bg-accent rounded-md px-4 py-2.5 text-center text-sm font-medium text-white no-underline hover:opacity-90"
            >
              Sign in to subscribe
            </a>
          </div>
        </Card>
      {/each}
    </div>

    <Card class="mx-auto mt-8 max-w-3xl text-sm leading-6 text-muted">
      Plans renew monthly until canceled. Prices are shown in EUR; applicable tax is calculated at checkout. You can cancel from the billing portal at any time, effective at the end of the current billing period.
    </Card>
  </main>
  <PublicPageFooter />
</div>
