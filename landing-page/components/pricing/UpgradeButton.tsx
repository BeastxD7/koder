"use client";

import { Suspense, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import CtaButton from "../../app/components/CtaButton";
import { startProCheckout } from "../../app/pricing/actions";

/**
 * The Pro plan card's real CTA (see app/pricing/actions.ts's doc comment for
 * why this exists — the button here used to be a hardcoded disabled "Coming
 * soon" placeholder that the IDE's own budget-cap upgrade link pointed
 * straight into). `startProCheckout()` either redirects the whole page away
 * (to Google sign-in, or straight to Dodo checkout) or resolves with
 * `{ok:false, error}` for a genuine failure — never both, so no try/catch is
 * needed here: a redirect unmounts this component before its promise would
 * otherwise resolve.
 *
 * `?checkout=pro` on this page (see actions.ts: the post-sign-in `next`
 * target) means "the visitor just finished signing in specifically to
 * upgrade" — re-invoke the action once mounted so they land on Dodo checkout
 * without a second click. `?promo=` carries a code typed before sign-in
 * through the same round trip. `?upgraded=1` is where a 100%-off code lands
 * (actions.ts grants Pro directly and redirects here instead of to Dodo,
 * since there's no checkout to redirect to) — shown as a static success
 * state rather than re-running go() again.
 */
function UpgradeButtonInner() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showPromo, setShowPromo] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const params = useSearchParams();
  const justUpgraded = params.get("upgraded") === "1";

  const go = (code?: string) => {
    setError(null);
    startTransition(async () => {
      const result = await startProCheckout(code);
      if (!result.ok) setError(result.error);
    });
  };

  useEffect(() => {
    // Nothing left to auto-resume once a 100%-off code already granted Pro.
    if (justUpgraded) return;
    const promoFromUrl = params.get("promo") ?? undefined;
    if (promoFromUrl) {
      setShowPromo(true);
      setPromoCode(promoFromUrl);
    }
    if (params.get("checkout") === "pro") go(promoFromUrl);
    // Intentionally run once on mount only — re-running on every params
    // change would re-trigger checkout if the visitor navigates away and
    // back with the query string still attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (justUpgraded) {
    return (
      <p className="mt-8 w-full rounded-full bg-lakshx-violet/10 px-4 py-3.5 text-center text-sm font-medium text-lakshx-violet">
        You&rsquo;re on Pro 🎉
      </p>
    );
  }

  return (
    <div className="mt-8 w-full">
      <CtaButton variant="accent" size="lg" disabled={pending} onClick={() => go(promoCode || undefined)} className="w-full">
        {pending ? "Redirecting…" : "Upgrade to Pro"}
      </CtaButton>

      {showPromo ? (
        <input
          type="text"
          value={promoCode}
          onChange={(e) => setPromoCode(e.target.value)}
          placeholder="Promo code"
          autoFocus
          className="mt-2.5 w-full rounded-full border border-ink-navy/15 bg-white px-4 py-2 text-center text-sm uppercase tracking-wide text-ink-navy placeholder:text-ink-navy/40 placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-lakshx-violet/40"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowPromo(true)}
          className="mt-2.5 w-full text-center text-xs text-ink-navy/50 underline decoration-ink-navy/20 underline-offset-2 hover:text-ink-navy/70"
        >
          Have a promo code?
        </button>
      )}
      {error && <p className="mt-2 text-center text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * `useSearchParams()` requires a Suspense boundary in the App Router (it
 * opts the subtree out of static rendering) — contained here so the pricing
 * page itself (a plain server component) doesn't need to know about it.
 */
export function UpgradeButton() {
  return (
    <Suspense fallback={<div className="mt-8 h-[52px] w-full animate-pulse rounded-full bg-ink-navy/[0.06]" />}>
      <UpgradeButtonInner />
    </Suspense>
  );
}
