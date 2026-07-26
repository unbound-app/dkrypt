export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link' | 'github';
export type ButtonSize = 'default' | 'sm' | 'icon';

export const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-transparent text-sm font-medium transition-[transform,background-color,border-color,box-shadow] duration-200 disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap cursor-pointer active:scale-[0.98]';

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  default: 'bg-accent text-accent-contrast shadow-[0_8px_22px_color-mix(in_srgb,var(--color-accent)_30%,transparent)] hover:-translate-y-px hover:brightness-105',
  secondary: 'border-border/70 bg-panel/45 text-text shadow-sm backdrop-blur hover:-translate-y-px hover:border-accent/45 hover:bg-panel-muted/75',
  outline: 'border-border/70 bg-transparent text-text hover:-translate-y-px hover:border-accent/45 hover:bg-panel-muted/60',
  ghost: 'text-text hover:bg-panel-muted/70',
  destructive: 'bg-err text-white shadow-[0_8px_22px_color-mix(in_srgb,var(--color-err)_26%,transparent)] hover:-translate-y-px hover:brightness-105',
  link: 'text-accent underline-offset-4 hover:underline',
  github: 'bg-[#24292f] text-white hover:opacity-90',
};

export const buttonSizeClasses: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2',
  sm: 'h-7 px-2.5 text-xs',
  icon: 'h-8 w-8 p-0',
};

export function buttonVariants(variant: ButtonVariant = 'default', size: ButtonSize = 'default'): string {
  return `${buttonBase} ${buttonVariantClasses[variant]} ${buttonSizeClasses[size]}`;
}

export type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';

export const badgeVariantClasses: Record<BadgeVariant, string> = {
  default: 'bg-accent/15 text-accent',
  success: 'bg-ok/15 text-ok',
  warning: 'bg-warn/15 text-warn',
  destructive: 'bg-err/15 text-err',
  secondary: 'bg-muted/15 text-muted',
  outline: 'border border-border text-text',
};

export function statusToBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case 'done':
    case 'approved':
      return 'success';
    case 'failed':
    case 'denied':
      return 'destructive';
    case 'running':
    case 'queued':
    case 'pending':
      return 'default';
    default:
      return 'secondary';
  }
}
