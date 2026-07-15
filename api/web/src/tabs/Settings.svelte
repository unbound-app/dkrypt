<script lang="ts">
  import Tabs from '../lib/components/ui/Tabs.svelte';
  import { setSettingsSubtab, tabState } from '../lib/ui.svelte';
  import AppleAuthSettings from './settings/AppleAuthSettings.svelte';
  import SchedulerSettings from './settings/SchedulerSettings.svelte';
  import UsersSettings from './settings/UsersSettings.svelte';

  const SUBTABS = [
    { id: 'scheduler', label: 'Scheduler' },
    { id: 'users', label: 'Users' },
    { id: 'apple', label: 'Apple Auth' },
  ];
</script>

<Tabs items={SUBTABS} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

<div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
  <SchedulerSettings />
</div>
<div class:hidden={tabState.settingsSubtab !== 'users'}>
  <UsersSettings />
</div>
<div class:hidden={tabState.settingsSubtab !== 'apple'}>
  <AppleAuthSettings />
</div>
