import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import Logo from "./Logo";

/**
 * Shared shell for the standalone legal pages (/terms, /privacy,
 * /refund-policy). Deliberately a lighter-weight version of
 * app/changelog/_components/ChangelogChrome.tsx / app/docs/_components/
 * DocsChrome.tsx — same fixed photo background + scrim, sticky glass top
 * bar, and `.docs-scope`/`.docs-prose` reading column, but with no sidebar,
 * TOC, or mobile drawer: these are single, short, linear documents, not a
 * multi-page nav tree, so that machinery would be pure ceremony here. The
 * three legal pages cross-link each other in the small footer below, since
 * there is no site-wide footer component yet to hang these links off of
 * (see the routes' page.tsx files for the rest of the note on that).
 */
export default function LegalChrome({ children }: { children: ReactNode }) {
  return (
    <div className="docs-scope relative min-h-dvh text-white">
      <div className="fixed inset-0 -z-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.jpg" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-[#0a0c12]/80" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0c12]/60 via-[#0a0c12]/85 to-[#0a0c12]/95" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0a0c12]/60 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo variant="light" />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/docs"
              className="hidden rounded-full px-3 py-2 text-white/70 transition hover:text-white sm:inline-block"
            >
              Docs
            </Link>
            <Link
              href="/changelog"
              className="hidden rounded-full px-3 py-2 text-white/70 transition hover:text-white sm:inline-block"
            >
              Changelog
            </Link>
            <Link
              href="/"
              className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-white/70 transition hover:text-white"
            >
              Home <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">{children}</main>

      <footer className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-white/10 pt-6 text-xs text-white/40">
          <Link href="/terms" className="underline decoration-white/20 transition hover:text-white/70 hover:decoration-white/50">
            Terms of Service
          </Link>
          <Link href="/privacy" className="underline decoration-white/20 transition hover:text-white/70 hover:decoration-white/50">
            Privacy Policy
          </Link>
          <Link href="/refund-policy" className="underline decoration-white/20 transition hover:text-white/70 hover:decoration-white/50">
            Refund Policy
          </Link>
        </div>
      </footer>
    </div>
  );
}
