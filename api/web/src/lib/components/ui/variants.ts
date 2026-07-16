export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link' | 'github';
export type ButtonSize = 'default' | 'sm' | 'icon';

export const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap cursor-pointer';

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  default: 'bg-accent text-accent-contrast hover:opacity-90',
  secondary: 'border border-border text-text hover:bg-panel-muted bg-transparent',
  outline: 'border border-border text-text hover:bg-panel-muted bg-transparent',
  ghost: 'text-text hover:bg-panel-muted',
  destructive: 'bg-err text-white hover:opacity-90',
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
