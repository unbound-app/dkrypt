<script lang="ts">
  import { ChevronDown } from 'lucide-svelte';
  import { fetchTestFlightBuilds, fetchTestFlightTrains, type TFBuild, type TFTrain } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import { fmtTime } from '../../lib/format';

  interface Props {
    open: boolean;
    bundleId: string;
    appId: number;
    trackName: string;
    onOpenChange: (open: boolean) => void;
    onDecrypt: (bundleId: string, appId: number, build: TFBuild, label: string) => void;
  }

  let { open, bundleId, appId, trackName, onOpenChange, onDecrypt }: Props = $props();

  let trains = $state<TFTrain[] | null>(null);
  let error = $state('');
  let loadedFor = $state(0);

  let expandedTrain = $state('');
  let builds = $state<TFBuild[] | null>(null);
  let buildsError = $state('');

  $effect(() => {
    if (!open || appId === loadedFor) return;
    loadedFor = appId;
    trains = null;
    error = '';
    expandedTrain = '';
    builds = null;
    fetchTestFlightTrains(appId)
      .then((data) => {
        if ('error' in data) {
          error = data.error;
          trains = [];
        } else {
          trains = data.trains;
        }
      })
      .catch(() => {
        error = 'Failed to load TestFlight trains - try again.';
        trains = [];
      });
  });

  async function toggleTrain(trainVersion: string): Promise<void> {
    if (expandedTrain === trainVersion) {
      expandedTrain = '';
      return;
    }
    expandedTrain = trainVersion;
    builds = null;
    buildsError = '';
    try {
      const data = await fetchTestFlightBuilds(appId, trainVersion);
      if ('error' in data) {
        buildsError = data.error;
        builds = [];
      } else {
        builds = data.builds;
      }
    } catch {
      buildsError = 'Failed to load builds - try again.';
      builds = [];
    }
  }

  function label(b: TFBuild): string {
    return `v${b.cfBundleShortVersion} (${b.cfBundleVersion})`;
  }
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-3 text-sm font-medium">{trackName} - TestFlight builds</div>

  {#if trains === null}
    <div class="text-sm text-muted">Loading beta trains from TestFlight (this may launch TestFlight on the device)…</div>
  {:else if error}
    <div class="text-err text-[13px]">{error}</div>
  {:else if trains.length === 0}
    <div class="text-sm text-muted">No beta trains found - is this app in your TestFlight?</div>
  {:else}
    <div class="max-h-[55vh] overflow-y-auto">
      {#each trains as t (t.trainVersion)}
        <div class="border-border border-t py-2 first:border-t-0">
          <button
            class="flex w-full cursor-pointer items-center justify-between gap-3 text-left text-[13px]"
            onclick={() => toggleTrain(t.trainVersion)}
          >
            <span class="flex items-center gap-1.5">
              <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted transition-transform {expandedTrain === t.trainVersion ? 'rotate-180' : ''}" />
              v{t.trainVersion}
            </span>
            <Badge variant="secondary">{t.buildCount} build{t.buildCount === 1 ? '' : 's'}</Badge>
          </button>

          {#if expandedTrain === t.trainVersion}
            <div class="mt-2 pl-3">
              {#if builds === null}
                <div class="text-muted text-xs">Loading builds…</div>
              {:else if buildsError}
                <div class="text-err text-xs">{buildsError}</div>
              {:else}
                {#each builds as b (b.id)}
                  <div class="flex items-center justify-between gap-3 py-1.5">
                    <div class="min-w-0">
                      <div class="text-[13px]">{label(b)}</div>
                      {#if b.releaseDate}
                        <div class="text-muted text-xs">{fmtTime(new Date(b.releaseDate).getTime())}</div>
                      {/if}
                    </div>
                    <Button size="sm" onclick={() => onDecrypt(bundleId, appId, b, label(b))}>Install &amp; decrypt</Button>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Dialog>
