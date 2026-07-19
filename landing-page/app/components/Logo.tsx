/**
 * LakshX wordmark: keeps the original app-icon mark (the purple
 * "spark" glyph — same gradient purple/violet used across the lakshx-chat
 * panel UI, and the same accent family this page now uses) inlined next to
 * the "LakshX" name in the heading font. The dedicated LakshX brand mark
 * didn't read well recolored for this page, so the spark glyph carries the
 * icon duty while the wordmark text carries the name change.
 */
export default function Logo({
  className,
  variant = "dark",
}: {
  className?: string;
  variant?: "dark" | "light";
}) {
  const textColor = variant === "light" ? "text-white" : "text-ink-navy";

  return (
    <span className={`inline-flex items-center gap-2.5 font-heading text-lg font-bold tracking-tight ${textColor} ${className ?? ""}`}>
      <svg viewBox="0 0 1024 1024" className="h-8 w-8" aria-hidden="true">
        <defs>
          <linearGradient id="lakshx-mark-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#15181f" />
            <stop offset="1" stopColor="#0a0c10" />
          </linearGradient>
          <linearGradient id="lakshx-mark-spark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9d7fff" />
            <stop offset="1" stopColor="#6a48f0" />
          </linearGradient>
        </defs>
        <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#lakshx-mark-bg)" />
        <rect
          x="64"
          y="64"
          width="896"
          height="896"
          rx="200"
          fill="none"
          stroke="#7c5cff"
          strokeOpacity="0.35"
          strokeWidth="8"
        />
        <path
          d="M512 200 L568 424 L768 320 L616 496 L824 512 L616 528 L768 704 L568 600 L512 824 L456 600 L256 704 L408 528 L200 512 L408 496 L256 320 L456 424 Z"
          fill="url(#lakshx-mark-spark)"
        />
        <circle cx="512" cy="512" r="56" fill="#0a0c10" />
        <circle cx="512" cy="512" r="34" fill="#c8b6ff" />
      </svg>
      LakshX
    </span>
  );
}
