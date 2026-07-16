import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Download } from "lucide-react";
import Logo from "../../components/Logo";

/**
 * The /changelog shell: the same fixed photo background + dark scrim and
 * sticky glass top bar as /docs (see app/docs/_components/DocsChrome.tsx),
 * minus the sidebar/TOC — a changelog is one continuous scroll, not a
 * multi-page nav tree, so it doesn't need either. Kept as a plain server
 * component (no client state) since there's no drawer to open here.
 */
export default function ChangelogChrome({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-dvh text-white">
      {/* Fixed photographic background + dark scrim, shared with the hero/docs. */}
      <div className="fixed inset-0 -z-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.jpg" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-[#0a0c12]/80" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0c12]/60 via-[#0a0c12]/85 to-[#0a0c12]/95" />
      </div>

      {/* Sticky top bar */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0a0c12]/60 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/changelog" className="flex items-center gap-2.5">
            <Logo variant="light" />
            <span className="hidden rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-xs font-medium text-white/60 sm:inline">
              Changelog
            </span>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/docs"
              className="hidden items-center gap-1 rounded-full px-3 py-2 text-sm text-white/70 transition hover:text-white sm:inline-flex"
            >
              Docs <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link
              href="/"
              className="hidden items-center gap-1 rounded-full px-3 py-2 text-sm text-white/70 transition hover:text-white sm:inline-flex"
            >
              Home <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-lakshx-violet to-lakshx-violet-active px-4 py-2 text-sm font-medium text-white shadow-lg shadow-lakshx-violet/30 transition hover:brightness-110"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Download</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">{children}</main>
    </div>
  );
}
