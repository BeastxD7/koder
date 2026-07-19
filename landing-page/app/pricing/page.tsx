import Link from "next/link";
import { Check, ArrowUpRight } from "lucide-react";
import Logo from "../components/Logo";
import CtaButton from "../components/CtaButton";
import SectionGlow from "../components/SectionGlow";
import SiteFooter from "../components/SiteFooter";

export const metadata = {
  title: "Pricing — LakshX",
  description: "LakshX pricing: Free (BYOK, uncapped), Pro ($15/mo), and Pro+ ($39/mo) with premium model access.",
};

const FREE_ITEMS = [
  "The full IDE — every agent mode, checkpoints & undo, voice mode",
  "Bring your own API key from any supported provider — fully unlimited, forever",
  "Or sign in free with Google for the hosted LakshX model, up to a $5 trial amount",
  "No credit card required",
];

const PRO_ITEMS = [
  "Everything in Free",
  "The hosted LakshX model (gpt-5-mini) with a generous monthly allowance — no key to manage",
  "Allowance resets every billing cycle, not a one-time trial",
  "Priority access to new features as they ship",
  "Support that goes straight to the team building it",
];

const PRO_PLUS_ITEMS = [
  "Everything in Pro",
  "Choose your model per task: Grok 4, GPT-5 (full), Claude Sonnet 5, or Claude Opus 4.8",
  "Same monthly allowance concept as Pro, sized for premium-model usage",
  "Falls back to gpt-5-mini (not a hard stop) if you use up your allowance before the cycle resets",
];

const RULES = [
  {
    q: "What happens when I use up my monthly allowance?",
    a: "On Free, you'll be prompted to upgrade — the hosted model pauses until you do (BYOK never has this limit). On Pro, hitting your allowance switches you to a lighter fallback model (gpt-5-nano) instead of cutting you off, so you can keep working; it resets in full at your next billing date. On Pro+, the same thing happens but the fallback is gpt-5-mini — a smaller step down from a premium model.",
  },
  {
    q: "Is BYOK really unlimited?",
    a: "Yes. If you bring your own API key from Anthropic, OpenAI, Gemini, DeepSeek, Groq, xAI, or OpenRouter, LakshX never meters or caps it — that traffic goes straight from your machine to your provider using your own key and your own billing with them.",
  },
  {
    q: "Do you show a token or credit counter?",
    a: "No. Your allowance is tracked as a dollar amount internally so we can keep the service sustainable, but you'll never see a raw token/request meter in the product — just “you're on Pro” or a heads-up when you're close to your next reset.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes, subscriptions can be cancelled at any time from your account; you keep access through the end of the current billing period. See the refund policy for details on billing-error exceptions.",
  },
];

function PlanCard({
  name,
  tagline,
  price,
  priceNote,
  items,
  featured = false,
  badge,
}: {
  name: string;
  tagline: string;
  price: string;
  priceNote: string;
  items: string[];
  featured?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={
        featured
          ? "relative flex flex-col rounded-3xl border border-lakshx-violet/25 bg-gradient-to-b from-lakshx-violet-active/15 to-white p-8 shadow-xl ring-1 ring-lakshx-violet/15 sm:p-10"
          : "flex flex-col rounded-3xl border border-ink-navy/[0.07] bg-white p-8 shadow-frame sm:p-10"
      }
    >
      {badge && (
        <span className="absolute -top-3 right-8 rounded-full bg-gradient-to-r from-lakshx-violet-active to-lakshx-violet px-3 py-1 text-xs font-semibold text-white shadow-md">
          {badge}
        </span>
      )}
      <h3 className="font-heading text-xl font-semibold text-ink-navy">{name}</h3>
      <p className="mt-1 text-sm text-ink-navy/50">{tagline}</p>
      <div className="mt-6 flex items-baseline gap-1">
        <span className="font-heading text-4xl font-bold tracking-tight text-ink-navy">{price}</span>
        <span className="text-sm text-ink-navy/50">{priceNote}</span>
      </div>

      <ul className="mt-8 flex flex-1 flex-col gap-3.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-sm text-ink-navy/70">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-lakshx-violet" aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>

      <CtaButton variant={featured ? "accent" : "outline"} size="lg" disabled className="mt-8 w-full">
        Coming soon
      </CtaButton>
    </div>
  );
}

export default function PricingPage() {
  return (
    <div className="relative">
      <header className="sticky top-0 z-40 border-b border-ink-navy/[0.06] bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6 sm:px-10">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/docs" className="hidden rounded-full px-3 py-2 text-ink-navy/70 transition hover:text-ink-navy sm:inline-block">
              Docs
            </Link>
            <Link href="/changelog" className="hidden rounded-full px-3 py-2 text-ink-navy/70 transition hover:text-ink-navy sm:inline-block">
              Changelog
            </Link>
            <Link href="/" className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-ink-navy/70 transition hover:text-ink-navy">
              Home <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative isolate overflow-hidden bg-white">
        <SectionGlow />

        <section className="mx-auto max-w-6xl px-6 py-20 sm:px-10 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-navy/10 bg-paper-dim px-4 py-1.5 text-sm font-medium text-ink-navy/70">
              Pricing
            </span>
            <h1 className="mt-5 text-balance font-heading text-3xl font-bold tracking-tight text-ink-navy sm:text-4xl">
              Start free. Upgrade when the hosted model becomes your daily driver.
            </h1>
            <p className="mt-4 text-base text-ink-navy/60 sm:text-lg">
              BYOK usage never has a cap, on any plan. Pro and Pro+ are for using LakshX&rsquo;s own hosted models
              without managing a key.
            </p>
          </div>

          <div className="mt-16 grid gap-6 lg:grid-cols-3">
            <PlanCard name="Free" tagline="For BYOK users, and anyone getting started" price="$0" priceNote="forever" items={FREE_ITEMS} />
            <PlanCard name="Pro" tagline="For daily use on the hosted model" price="$15" priceNote="/ month" items={PRO_ITEMS} featured badge="Coming soon" />
            <PlanCard
              name="Pro+"
              tagline="For premium models — Grok 4, GPT-5, Claude Sonnet 5, Opus"
              price="$39"
              priceNote="/ month"
              items={PRO_PLUS_ITEMS}
              featured
              badge="Coming soon"
            />
          </div>

          <div className="mx-auto mt-24 max-w-3xl">
            <h2 className="text-center font-heading text-2xl font-bold tracking-tight text-ink-navy">How the plans actually work</h2>
            <div className="mt-8 flex flex-col gap-6">
              {RULES.map((r) => (
                <div key={r.q} className="rounded-2xl border border-ink-navy/[0.07] bg-white/80 p-6 shadow-frame backdrop-blur-sm">
                  <h3 className="font-heading text-base font-semibold text-ink-navy">{r.q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-navy/60">{r.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <SiteFooter />
      </main>
    </div>
  );
}
