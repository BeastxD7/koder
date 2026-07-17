import Link from "next/link";
import { GitCommitHorizontal } from "lucide-react";
import { CHANGELOG_ENTRIES, DATE_BLURBS, REPO_URL, type ChangelogCategory } from "./_data/entries";
import CategoryBadge from "./_components/CategoryBadge";

// Fixed display order for category subsections within a date group — an
// arbitrary but stable order (roughly: core product first, infra last).
const CATEGORY_ORDER: ChangelogCategory[] = ["Agent", "Security", "Databases", "UI", "Build/Distribution", "Docs"];

function formatDate(dateStr: string): string {
  // Parse as UTC midnight so the displayed date never shifts a day in
  // either direction depending on the reader's timezone.
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default function ChangelogPage() {
  const dates = Array.from(new Set(CHANGELOG_ENTRIES.map((e) => e.date))).sort((a, b) => b.localeCompare(a));

  return (
    // Same shell convention as DocArticle (app/docs/_components/DocArticle.tsx):
    // a fixed id the right-hand Toc scans for h2/h3 headings (see
    // ChangelogChrome's <Toc articleId="changelog-article" />), at the same
    // max-w-3xl reading measure every docs page uses.
    <article id="changelog-article" className="mx-auto max-w-3xl">
      <header className="mb-12">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-lakshx-violet-active">
          Changelog
        </p>
        <h1 className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl">
          What shipped, day by day
        </h1>
        <p className="mt-4 text-base leading-relaxed text-white/70 sm:text-lg">
          Every entry below is generated from LakshX&rsquo;s own commit history — grouped by the day it landed, tagged
          by rough area, with the commit hash linking straight to the source. Nothing here is aspirational; if it&rsquo;s
          listed, it shipped. See{" "}
          <Link href="/docs" className="text-lakshx-violet-active underline decoration-white/30 transition hover:decoration-white/70">
            the docs
          </Link>{" "}
          for how each feature actually works, or head back{" "}
          <Link href="/" className="text-lakshx-violet-active underline decoration-white/30 transition hover:decoration-white/70">
            home
          </Link>
          .
        </p>
      </header>

      <div className="flex flex-col gap-8">
        {dates.map((date) => {
          const dayEntries = CHANGELOG_ENTRIES.filter((e) => e.date === date);
          const blurb = DATE_BLURBS[date];
          return (
            <section
              key={date}
              className="rounded-2xl border border-white/10 bg-white/[0.05] p-6 backdrop-blur-2xl sm:p-8"
            >
              <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-white/10 pb-5">
                <h2 id={date} className="scroll-mt-24 font-heading text-xl font-bold text-white sm:text-2xl">
                  {formatDate(date)}
                </h2>
                <span className="text-sm text-white/45">
                  {dayEntries.length} commit{dayEntries.length === 1 ? "" : "s"}
                </span>
              </div>

              {blurb && <p className="mb-6 text-sm leading-relaxed text-white/60">{blurb}</p>}

              <div className="flex flex-col gap-6">
                {CATEGORY_ORDER.map((category) => {
                  const catEntries = dayEntries.filter((e) => e.category === category);
                  if (!catEntries.length) return null;
                  return (
                    <div key={category}>
                      <div className="mb-2.5 flex items-center gap-2">
                        <CategoryBadge category={category} />
                      </div>
                      <ul className="flex flex-col gap-2">
                        {catEntries.map((entry) => (
                          <li key={entry.hash} className="flex items-start gap-2.5 text-sm leading-relaxed text-white/75">
                            <GitCommitHorizontal
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/30"
                              aria-hidden="true"
                            />
                            <span className="min-w-0">
                              {entry.text}{" "}
                              <a
                                href={`${REPO_URL}/commit/${entry.hash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="whitespace-nowrap rounded border border-white/10 bg-black/30 px-1.5 py-0.5 font-mono text-[0.72rem] text-white/45 no-underline transition hover:border-lakshx-violet/40 hover:text-lakshx-violet-active"
                              >
                                {entry.hash}
                              </a>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-10 text-center text-xs text-white/35">
        Sourced from <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/60">git log</code> across
        the whole repo — {CHANGELOG_ENTRIES.length} commits, {dates[dates.length - 1]} through {dates[0]}.
      </p>
    </article>
  );
}
