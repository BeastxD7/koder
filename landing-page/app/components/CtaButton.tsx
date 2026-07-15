import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "glass";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:hover:scale-100";

const sizeClass: Record<Size, string> = {
  sm: "px-5 py-2.5 text-sm",
  md: "px-6 py-3 text-sm",
  lg: "px-7 py-3.5 text-base",
};

const variantClass: Record<Variant, string> = {
  // Solid gradient fill, not translucent/glass — reads clearly against the
  // photo background instead of blending into it.
  primary:
    "bg-gradient-to-r from-lakshx-violet to-lakshx-violet-active text-white shadow-lg shadow-lakshx-violet/30 hover:brightness-110 focus:ring-lakshx-violet/40",
  glass:
    "border border-white/30 bg-white/10 text-white backdrop-blur-md hover:bg-white/20 focus:ring-white/40",
};

interface CtaButtonProps {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  href?: string;
  disabled?: boolean;
  className?: string;
  onClick?: () => void;
}

/**
 * Shared CTA button/link. Renders an <a> when `href` is given (so real
 * download links are proper links, not JS-only clicks), or a <button> for
 * in-page actions. `disabled` renders a visually inert, non-clickable state
 * — used for download targets that aren't configured yet so a placeholder
 * link never looks like a working download.
 */
export default function CtaButton({
  children,
  variant = "primary",
  size = "md",
  href,
  disabled = false,
  className,
  onClick,
}: CtaButtonProps) {
  const classes = `${base} ${sizeClass[size]} ${variantClass[variant]} ${className ?? ""}`;

  if (disabled || !href) {
    return (
      <button type="button" className={classes} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }

  return (
    <Link href={href} className={classes} onClick={onClick}>
      {children}
    </Link>
  );
}
