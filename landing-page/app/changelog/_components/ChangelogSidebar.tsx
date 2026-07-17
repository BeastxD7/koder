"use client";

import { useEffect, useState } from "react";
import { CHANGELOG_ENTRIES } from "../_data/entries";

function formatShort(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Left-hand "jump to a day" nav — the changelog's analog of DocsSidebar's
 * page tree. A changelog is one continuous page rather than many, so instead
 * of cross-page links this lists every date section on the CURRENT page as
 * an anchor, mirroring DocsSidebar's grouped-list visual shape (uppercase
 * group label, active-state highlight) so /changelog reads as the same
 * product as /docs rather than a bolted-on one-off layout.
 *
 * Highlights the date whose <h2 id={date}> is currently in view — same
 * IntersectionObserver approach as Toc.tsx, kept separate (rather than
 * sharing Toc directly) since this is a persistent rail, not a "this page's
 * headings" scanner, and needs its own list even on days Toc would trim.
 */
export default function ChangelogSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const dates = Array.from(new Set(CHANGELOG_ENTRIES.map((e) => e.date))).sort((a, b) => b.localeCompare(a));
  const [activeDate, setActiveDate] = useState<string>(dates[0] ?? "");

  useEffect(() => {
    const nodes = dates.map((d) => document.getElementById(d)).filter((n): n is HTMLElement => !!n);
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveDate(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: [0, 1] }
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <nav className="flex flex-col gap-7 pb-16 text-sm">
      <div>
        <p className="mb-2.5 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Timeline</p>
        <ul className="space-y-0.5">
          {dates.map((date) => {
            const active = activeDate === date;
            const count = CHANGELOG_ENTRIES.filter((e) => e.date === date).length;
            return (
              <li key={date}>
                <a
                  href={`#${date}`}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center justify-between rounded-lg px-3 py-1.5 transition ${
                    active
                      ? "bg-lakshx-violet/20 font-medium text-white ring-1 ring-inset ring-lakshx-violet/40"
                      : "text-white/60 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span>{formatShort(date)}</span>
                  <span className="rounded-full border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/50">
                    {count}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
