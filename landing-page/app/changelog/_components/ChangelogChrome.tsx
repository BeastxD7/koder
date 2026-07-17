"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X, ArrowUpRight, Download } from "lucide-react";
import Logo from "../../components/Logo";
import ChangelogSidebar from "./ChangelogSidebar";
import Toc from "../../docs/_components/Toc";

/**
 * The /changelog shell — deliberately the SAME structure as
 * app/docs/_components/DocsChrome.tsx (fixed photo background + scrim,
 * sticky glass top bar, persistent left sidebar with a mobile drawer,
 * article column, right-hand TOC rail on wide screens), just with
 * ChangelogSidebar swapped in for DocsSidebar and Toc pointed at this page's
 * own article id. A changelog is one continuous scroll rather than a
 * multi-page nav tree, so ChangelogSidebar lists "jump to this date" anchors
 * on the current page instead of links to other pages — everything else
 * (grid widths, breakpoints, drawer behavior) is copied as-is so /docs and
 * /changelog read as the same product, not two different ones bolted
 * together.
 */
export default function ChangelogChrome({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  return (
    <div className="docs-scope relative min-h-dvh text-white">
      {/* Fixed photographic background + dark scrim, shared with the hero/docs. */}
      <div className="fixed inset-0 -z-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.jpg" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-[#0a0c12]/80" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0c12]/60 via-[#0a0c12]/85 to-[#0a0c12]/95" />
      </div>

      {/* Sticky top bar */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0a0c12]/60 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[90rem] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <Link href="/changelog" className="flex items-center gap-2.5">
              <Logo variant="light" />
              <span className="hidden rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-xs font-medium text-white/60 sm:inline">
                Changelog
              </span>
            </Link>
          </div>

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

      {/* Main grid — same shape as DocsChrome's */}
      <div className="mx-auto flex max-w-[90rem] gap-8 px-4 sm:px-6">
        {/* Desktop sidebar */}
        <aside className="docs-scrollbar sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 overflow-y-auto py-8 lg:block">
          <ChangelogSidebar />
        </aside>

        {/* Article column */}
        <main className="min-w-0 flex-1 py-10">{children}</main>

        {/* Right TOC rail — scans #changelog-article's own h2s (one per date) */}
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-56 shrink-0 overflow-y-auto py-10 xl:block">
          <Toc articleId="changelog-article" />
        </aside>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              className="docs-scrollbar fixed inset-y-0 left-0 z-50 w-[19rem] max-w-[85vw] overflow-y-auto border-r border-white/10 bg-[#0b0d14]/95 px-4 py-5 backdrop-blur-2xl lg:hidden"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "tween", duration: 0.22, ease: "easeOut" }}
            >
              <div className="mb-6 flex items-center justify-between">
                <Logo variant="light" />
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                  aria-label="Close navigation"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              <ChangelogSidebar onNavigate={() => setDrawerOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
