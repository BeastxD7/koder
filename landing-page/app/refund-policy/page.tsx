import DocHeader from "../docs/_components/DocHeader";
import Callout from "../docs/_components/Callout";

export default function RefundPolicyPage() {
  return (
    <article className="docs-prose">
      <DocHeader eyebrow="Legal" title="Refund Policy">
        LakshX doesn&rsquo;t have a live paid plan yet — the hosted model is currently free, within its budget
        caps. This page sets out the refund policy we intend to run once paid plans launch, so it&rsquo;s in
        place from day one rather than written after the fact.
      </DocHeader>

      <Callout variant="note" title="Questions?">
        This is a standard, industry-typical SaaS refund policy drafted ahead of pricing being finalized — a
        few specific numbers below are reasonable defaults, not final decisions. If you have questions about
        billing, email <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>.
      </Callout>

      <p className="text-sm text-white/50">
        <em>Last updated: July 19, 2026</em>
      </p>

      <h2>1. Current Status: No Paid Plans Yet</h2>
      <p>
        As of this writing, LakshX&rsquo;s hosted AI model is offered free of charge, subject to a per-user
        budget cap and an overall budget ceiling. No payment is currently required to use it, so there is
        nothing to refund today. This policy describes how refunds will work once we introduce paid
        subscriptions and/or usage-based credits.
      </p>

      <h2>2. Subscription Charges</h2>
      <p>
        If you subscribe to a paid plan, you may request a full refund within{" "}
        <strong>14 days</strong> of your <em>first</em> subscription charge, no questions asked.
      </p>
      {/*
        FOUNDER TODO: "14 days" is a reasonable, common SaaS-industry default
        for a new-subscriber money-back window — not a number pulled from
        this product's actual pricing, since that doesn't exist yet. Confirm
        or change once the real subscription plan (monthly/annual, price
        points) is decided.
      */}
      <p>
        Renewal charges after the first billing cycle are non-refundable, except where required by law, or at
        our discretion for exceptional circumstances (for example, a billing error on our part, or a
        significant outage affecting your ability to use the Service).
      </p>
      <p>
        If you cancel a subscription, you&rsquo;ll retain access through the end of your current billing
        period; we do not currently offer pro-rated refunds for the unused portion of a billing period outside
        the 14-day window above.
      </p>
      {/*
        FOUNDER TODO: whether renewals get any pro-rated refund, and the
        exact cancellation-timing behavior, should be revisited once the
        actual subscription mechanics (monthly vs. annual, auto-renew terms)
        are locked in.
      */}

      <h2>3. Usage-Based Credits</h2>
      <p>
        If a plan is metered or credit-based (for example, pay-as-you-go usage on top of or instead of a flat
        subscription), <strong>credits or usage already consumed are non-refundable.</strong> Unused,
        unexpired credit balances may be refundable within the same 14-day window described above for a
        first-time purchase; beyond that window, unused credits are non-refundable but do not expire unless
        stated otherwise at the time of purchase.
      </p>
      {/*
        FOUNDER TODO: exact credit expiry behavior (if any) and whether
        unused-credit refunds should be allowed past 14 days are both
        placeholders pending the actual metered-pricing design.
      */}

      <h2>4. How to Request a Refund</h2>
      <p>
        Email <a href="mailto:contact@lakshx.in">contact@lakshx.in</a> with your account email and the charge
        you&rsquo;re asking about. We aim to process eligible refunds back to your original payment method
        within 10 business days of approval.
      </p>

      <h2>5. Chargebacks</h2>
      <p>
        We&rsquo;d rather resolve a billing issue directly — please reach out before filing a chargeback with
        your bank or card provider. Accounts with an open, unresolved chargeback may be suspended while the
        dispute is investigated.
      </p>

      <h2>6. Changes to This Policy</h2>
      <p>
        This policy will be revisited and updated once actual pricing and payment mechanics are finalized, and
        may change thereafter as our plans evolve. We&rsquo;ll update the &ldquo;Last updated&rdquo; date above
        whenever we do.
      </p>

      <h2>7. Contact</h2>
      <p>
        Questions about billing or refunds? Email{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>.
      </p>
    </article>
  );
}
