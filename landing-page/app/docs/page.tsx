import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import DocHeader from "./_components/DocHeader";
import Callout from "./_components/Callout";
import PageNav from "./_components/PageNav";
import { DOCS_NAV } from "./_components/nav";

export const metadata: Metadata = {
  title: "Overview",
  description: "What LakshX is, and a map of everything the IDE can do.",
};

// Skip "Getting Started" (this page) in the card grid; show the feature groups.
const CARD_GROUPS = DOCS_NAV.filter((g) => g.label !== "Getting Started");

export default function DocsIndexPage() {
  return (
    <article id="docs-article" className="docs-prose mx-auto max-w-4xl">
      <DocHeader eyebrow="Getting Started" title="LakshX Documentation">
        LakshX is a VS Code fork with a real coding agent inside. It plans, edits, and runs commands
        across your repo — at whatever safety level you choose — and it runs locally with your own model.
        These docs cover every shipped feature and how to use it.
      </DocHeader>

      <h2>Start here</h2>
      <p>
        New to LakshX? <Link href="/docs/installation">Install it</Link> for your platform, then{" "}
        <Link href="/docs/sign-in">sign in or add a model</Link> and open the{" "}
        <Link href="/docs/chat">chat panel</Link>{" "}
        and say what you want built. Before you let the agent
        loose, it&rsquo;s worth understanding the <Link href="/docs/modes">safety modes</Link> — they decide
        how much the agent can do without asking.
      </p>

      <Callout variant="note" title="Free hosted model, or bring your own">
        LakshX runs on your machine. Sign in with Google for the free hosted model — no key needed — or{" "}
        <Link href="/docs/sign-in">configure your own provider key</Link>. Either way, nothing about your
        code leaves your machine except what you explicitly send to the model you&rsquo;ve chosen.
      </Callout>

      <h2>Explore the features</h2>
      <div className="not-prose mt-6 grid gap-6">
        {CARD_GROUPS.map((group) => (
          <section key={group.label}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-white/40">
              {group.label}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.pages.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.05] p-5 backdrop-blur-md transition hover:border-lakshx-violet/40 hover:bg-white/[0.09]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-heading font-semibold text-white">{page.title}</span>
                    {page.badge ? (
                      <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/50">
                        {page.badge}
                      </span>
                    ) : (
                      <ArrowRight className="h-4 w-4 text-white/30 transition group-hover:translate-x-0.5 group-hover:text-lakshx-violet-active" aria-hidden="true" />
                    )}
                  </div>
                  {page.blurb && <p className="mt-2 text-sm leading-relaxed text-white/60">{page.blurb}</p>}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      <PageNav />
    </article>
  );
}
