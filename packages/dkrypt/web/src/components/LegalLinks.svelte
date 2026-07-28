<script lang="ts">
  const links = [
    { href: '/pricing', label: 'Pricing' },
    { href: '/terms', label: 'Terms' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/refund-policy', label: 'Refund policy' },
    { href: '/contact', label: 'Contact' },
  ];
</script>

<nav aria-label="Legal and support" class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted">
  {#each links as link (link.href)}
    <a href={link.href} class="hover:text-text">{link.label}</a>
  {/each}
</nav>
