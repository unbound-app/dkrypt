<script lang="ts">
  import Switch from '../lib/components/ui/Switch.svelte';
  import { hasPermission, PERMISSION_META, PermissionFlag, type PermissionFlagKey, type PermissionGroup } from '../lib/permissions';

  interface Props {
    value: bigint;
  }

  let { value = $bindable() }: Props = $props();

  const GROUP_ORDER: PermissionGroup[] = ['General', 'API Keys', 'Automation & Devices', 'Apple Authentication', 'Members & Roles', 'Backups'];

  const groups = GROUP_ORDER.map((title) => ({ title, fields: PERMISSION_META.filter((f) => f.group === title) })).filter(
    (g) => g.fields.length > 0,
  );

  function toggle(key: PermissionFlagKey): void {
    const flag = PermissionFlag[key];
    value = (value & flag) !== 0n ? value & ~flag : value | flag;
  }
</script>

<div class="border-border divide-y rounded-lg border">
  {#each groups as group (group.title)}
    <div class="px-3 py-2">
      <div class="mb-0.5 text-[10px] font-semibold tracking-wider text-muted uppercase">{group.title}</div>
      {#each group.fields as f (f.key)}
        {@const isAdminBit = f.key === 'administrator'}
        {@const checked = isAdminBit ? (value & PermissionFlag.administrator) !== 0n : hasPermission(value, PermissionFlag[f.key])}
        {@const impliedByAdmin = !isAdminBit && (value & PermissionFlag.administrator) !== 0n}
        <div class="flex items-center gap-3 py-1.5">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] text-text" class:font-semibold={isAdminBit}>{f.label}</div>
            <div class="text-[11px] leading-4 text-muted">
              {impliedByAdmin ? 'Granted by Administrator' : f.description}
            </div>
          </div>
          <Switch checked={checked} disabled={impliedByAdmin} onCheckedChange={() => toggle(f.key)} aria-label={f.label} />
        </div>
      {/each}
    </div>
  {/each}
</div>
