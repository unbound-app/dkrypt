export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link' | 'github' | 'discord';
export type ButtonSize = 'default' | 'sm' | 'icon';

export const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
  outline: 'border-input bg-background shadow-sm hover:bg-secondary hover:text-secondary-foreground',
  ghost: 'hover:bg-secondary hover:text-secondary-foreground',
  destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline',
  github: 'bg-[#24292f] text-white hover:opacity-90',
  discord: 'bg-[#5865f2] text-white hover:opacity-90',
};

export const buttonSizeClasses: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  icon: 'h-9 w-9 p-0',
};

export function buttonVariants(variant: ButtonVariant = 'default', size: ButtonSize = 'default'): string {
  return `${buttonBase} ${buttonVariantClasses[variant]} ${buttonSizeClasses[size]}`;
}

export type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';

export const badgeVariantClasses: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary/15 text-foreground',
  success: 'border-transparent bg-ok/15 text-ok',
  warning: 'border-transparent bg-warn/15 text-warn',
  destructive: 'border-transparent bg-destructive/15 text-destructive',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
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
