<script lang="ts">
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { pushSettingsModePref, sessionHasAnyPermission, sessionHasPermission } from '#lib/session.svelte';
  import { interfaceLanguageState, settingsModeState, setSettingsSubtab, systemLocalesState, tabState } from '#lib/ui.svelte';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { translateMessage } from '#lib/messages';
  import { createVisitedTabs } from '#lib/visitedTabs.svelte';
  import BackupSettings from '#features/administration/BackupSettings.svelte';
  import BillingSettings from '#features/billing/BillingManagement.svelte';
  import ArtifactStorageSettings from '#features/artifacts/ArtifactStorageSettings.svelte';
  import DevicesSettings from '#features/devices/DevicesSettings.svelte';
  import ProjectsSettings from '#features/administration/ProjectsSettings.svelte';
  import RolesSettings from '#features/administration/RolesSettings.svelte';
  import SchedulerSettings from '#features/scheduler/SchedulerSettings.svelte';
  import SystemDoctorSettings from '#features/administration/SystemDoctorSettings.svelte';
  import TestFlightSettings from '#features/testflight/TestFlightSettings.svelte';
  import UsersSettings from '#features/administration/UsersSettings.svelte';

  const ALL_SUBTABS: { id: string; label: string; requires: bigint[]; requiresAll?: bigint[] }[] = [
    { id: 'scheduler', label: 'Automation', requires: [PermissionFlag.viewAutomation, PermissionFlag.manageAutomation] },
    { id: 'storage', label: 'Storage', requires: [PermissionFlag.manageAutomation], requiresAll: [PermissionFlag.requestDecrypt] },
    { id: 'devices', label: 'Devices', requires: [PermissionFlag.viewDevices, PermissionFlag.manageDevices] },
    { id: 'doctor', label: 'System', requires: [PermissionFlag.manageDevices] },
    { id: 'users', label: 'Users', requires: [PermissionFlag.viewUsers, PermissionFlag.manageUsers] },
    { id: 'roles', label: 'Roles', requires: [PermissionFlag.viewRoles, PermissionFlag.manageRoles] },
    { id: 'projects', label: 'Projects', requires: [PermissionFlag.viewProjects, PermissionFlag.manageProjects] },
    { id: 'backup', label: 'Backup', requires: [PermissionFlag.viewBackup, PermissionFlag.manageBackup] },
    { id: 'testflight', label: 'TestFlight', requires: [PermissionFlag.manageTestFlightSubscriptions] },
    { id: 'billing', label: 'Billing', requires: [PermissionFlag.viewBilling, PermissionFlag.manageBilling] },
  ];

  function hasAccess(requires: bigint[], requiresAll: bigint[] = []): boolean {
    return sessionHasAnyPermission(requires) && requiresAll.every(sessionHasPermission);
  }

  const visibleSubtabs = $derived(ALL_SUBTABS.filter((subtab) => hasAccess(subtab.requires, subtab.requiresAll)));
  const mountedSubtabs = createVisitedTabs(() => tabState.settingsSubtab);
  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
  const msg = (key: 'settings.modeLabel' | 'settings.basicMode' | 'settings.advancedMode' | 'settings.advancedModeDescription') => translateMessage(key, interfaceLanguage);

  $effect(() => {
    if (visibleSubtabs.length > 0 && !visibleSubtabs.some((t) => t.id === tabState.settingsSubtab)) {
      setSettingsSubtab(visibleSubtabs[0].id);
    }
  });

</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-panel/50 px-4 py-3">
  <div>
    <div class="text-sm font-semibold">{msg('settings.modeLabel')}</div>
    <div class="text-xs text-muted">{msg('settings.advancedModeDescription')}</div>
  </div>
  <div class="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label={msg('settings.modeLabel')}>
    <Button size="sm" variant={settingsModeState.value === 'basic' ? 'secondary' : 'ghost'} aria-pressed={settingsModeState.value === 'basic'} onclick={() => void pushSettingsModePref('basic')}>{msg('settings.basicMode')}</Button>
    <Button size="sm" variant={settingsModeState.value === 'advanced' ? 'secondary' : 'ghost'} aria-pressed={settingsModeState.value === 'advanced'} onclick={() => void pushSettingsModePref('advanced')}>{msg('settings.advancedMode')}</Button>
  </div>
</div>

<Tabs items={visibleSubtabs} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

{#if hasAccess([PermissionFlag.viewAutomation, PermissionFlag.manageAutomation]) && mountedSubtabs.scheduler}
  <div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
    <SchedulerSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageAutomation], [PermissionFlag.requestDecrypt]) && mountedSubtabs.storage}
  <div class:hidden={tabState.settingsSubtab !== 'storage'}>
    <ArtifactStorageSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewDevices, PermissionFlag.manageDevices]) && mountedSubtabs.devices}
  <div class:hidden={tabState.settingsSubtab !== 'devices'}>
    <DevicesSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageDevices]) && mountedSubtabs.doctor}
  <div class:hidden={tabState.settingsSubtab !== 'doctor'}>
    <SystemDoctorSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewUsers, PermissionFlag.manageUsers]) && mountedSubtabs.users}
  <div class:hidden={tabState.settingsSubtab !== 'users'}>
    <UsersSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewRoles, PermissionFlag.manageRoles]) && mountedSubtabs.roles}
  <div class:hidden={tabState.settingsSubtab !== 'roles'}>
    <RolesSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewProjects, PermissionFlag.manageProjects]) && mountedSubtabs.projects}
  <div class:hidden={tabState.settingsSubtab !== 'projects'}>
    <ProjectsSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewBackup, PermissionFlag.manageBackup]) && mountedSubtabs.backup}
  <div class:hidden={tabState.settingsSubtab !== 'backup'}>
    <BackupSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageTestFlightSubscriptions]) && mountedSubtabs.testflight}
  <div class:hidden={tabState.settingsSubtab !== 'testflight'}>
    <TestFlightSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewBilling, PermissionFlag.manageBilling]) && mountedSubtabs.billing}
  <div class:hidden={tabState.settingsSubtab !== 'billing'}>
    <BillingSettings />
  </div>
{/if}
