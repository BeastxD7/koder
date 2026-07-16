import type { ChangelogCategory } from "../_data/entries";

/**
 * Small colored pill labeling each entry's rough area, in the same glass-chip
 * language as Callout's variant colors (app/docs/_components/Callout.tsx) —
 * violet for agent/runtime work, green for databases, sky for docs/research,
 * amber for build & distribution, neutral white for everything else (UI,
 * landing page, rebrand). Deliberately just 5 buckets per the brief — this
 * is meant to be scannable, not a taxonomy.
 */
const STYLES: Record<ChangelogCategory, { label: string; className: string }> = {
  Agent: { label: "Agent", className: "border-lakshx-violet/40 bg-lakshx-violet/10 text-lakshx-violet-active" },
  Databases: { label: "Databases", className: "border-[#8ee6a8]/30 bg-[#8ee6a8]/10 text-[#8ee6a8]" },
  Docs: { label: "Docs", className: "border-[#7dd3fc]/30 bg-[#7dd3fc]/10 text-[#7dd3fc]" },
  "Build/Distribution": { label: "Build", className: "border-[#f0b866]/30 bg-[#f0b866]/10 text-[#f0b866]" },
  UI: { label: "UI", className: "border-white/15 bg-white/[0.06] text-white/60" },
};

export default function CategoryBadge({ category }: { category: ChangelogCategory }) {
  const { label, className } = STYLES[category];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}
    >
      {label}
    </span>
  );
}
