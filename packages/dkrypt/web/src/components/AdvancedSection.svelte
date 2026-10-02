<script lang="ts">
  import type { Snippet } from 'svelte';
  import { interfaceLanguageState, settingsModeState, systemLocalesState } from '#lib/ui.svelte';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { translateMessage, type MessageKey } from '#lib/messages';

  interface Props {
    children: Snippet;
    label?: MessageKey;
  }

  let { children, label }: Props = $props();
  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
  const summary = $derived(translateMessage(label ?? 'settings.advancedControls', interfaceLanguage));
</script>

{#if settingsModeState.value === 'advanced'}
  {@render children()}
{:else}
  <details class="advanced-disclosure">
    <summary>{summary}</summary>
    {@render children()}
  </details>
{/if}
