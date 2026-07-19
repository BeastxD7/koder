import Link from "next/link";
import Logo from "./Logo";

/**
 * The homepage's full footer — a fuller sibling to LegalChrome.tsx's thin
 * legal-links row, now that there's real page content below a single hero.
 * Deliberately small: this is a pre-revenue product's marketing site, not an
 * enterprise footer with a dozen columns.
 *
 * No own background/overflow-hidden/SectionGlow — plain content inside the
 * shared violet-wash wrapper in page.tsx, same as Features/Pricing. The
 * top border is a deliberate thin footer rule, not a background seam.
 */
export default function SiteFooter() {
  return (
    <footer className="relative border-t border-ink-navy/[0.06] py-14">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 sm:px-10">
        <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-2.5">
            <Logo />
            <p className="max-w-xs text-sm text-ink-navy/50">
              An agentic coding IDE — plans, edits, and runs commands across your repo, at whatever safety
              level you choose.
            </p>
          </div>

          <nav className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            <Link href="/docs" className="text-ink-navy/70 transition hover:text-ink-navy">
              Docs
            </Link>
            <Link href="/changelog" className="text-ink-navy/70 transition hover:text-ink-navy">
              Changelog
            </Link>
            <Link href="/terms" className="text-ink-navy/70 transition hover:text-ink-navy">
              Terms of Service
            </Link>
            <Link href="/privacy" className="text-ink-navy/70 transition hover:text-ink-navy">
              Privacy Policy
            </Link>
            <Link href="/refund-policy" className="text-ink-navy/70 transition hover:text-ink-navy">
              Refund Policy
            </Link>
          </nav>
        </div>

        <div className="flex flex-col-reverse items-center justify-between gap-4 border-t border-ink-navy/[0.06] pt-6 text-xs text-ink-navy/40 sm:flex-row">
          <p>&copy; {new Date().getFullYear()} LakshX. All rights reserved.</p>
          <p>Made for developers who ship.</p>
        </div>
      </div>
    </footer>
  );
}
