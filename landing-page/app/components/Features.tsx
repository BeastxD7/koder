"use client";

import { motion } from "framer-motion";
import { ShieldCheck, RotateCcw, KeyRound, Mic } from "lucide-react";

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } },
};

// Same brand violet on every card (see Logo.tsx/globals.css) — the
// departure from the hero isn't a different hue, it's a lighter/airier
// tint of the same accent color, so the page still reads as one product.
const FEATURES = [
  {
    icon: ShieldCheck,
    title: "Pick your autonomy level",
    body:
      "Review, Approve, Auto, or Royal — the agent runs read-only plans, asks before every edit, acts on its own behind a safety floor, or (once you consent) drops the floor entirely for full machine access. One dropdown, four very different agents.",
  },
  {
    icon: RotateCcw,
    title: "Every edit is reversible",
    body:
      "LakshX quietly checkpoints your files before the agent touches them. Undo one file, one message, or an entire session, with a real diff view — even in Royal mode, where nothing else holds the agent back.",
  },
  {
    icon: KeyRound,
    title: "Any provider, or the free hosted model",
    body:
      "Bring your own key for Anthropic, OpenAI, Gemini, DeepSeek, Groq, xAI, or OpenRouter's hundreds of models — or sign in with Google and use LakshX's own hosted model with no key at all.",
  },
  {
    icon: Mic,
    title: "Talk to your agent",
    body:
      "Push-to-talk dictation straight into the composer, transcribed fully offline on your machine. No cloud speech API, no account, and vocabulary tuned for code and identifiers, not general conversation.",
  },
];

// No own background/overflow-hidden/SectionGlow here — this renders as
// plain content inside the single shared violet-wash wrapper in page.tsx
// (alongside Pricing/SiteFooter), so there's no per-section seam.
export default function Features() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6 sm:px-10">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.3 }}
          className="mx-auto max-w-2xl text-center"
        >
          <motion.span
            variants={fadeUp}
            className="inline-flex items-center gap-1.5 rounded-full border border-ink-navy/10 bg-paper-dim px-4 py-1.5 text-sm font-medium text-ink-navy/70"
          >
            Built for real repos
          </motion.span>
          <motion.h2
            variants={fadeUp}
            className="mt-5 text-balance font-heading text-3xl font-bold tracking-tight text-ink-navy sm:text-4xl"
          >
            An agent you can actually trust with your codebase
          </motion.h2>
          <motion.p variants={fadeUp} className="mt-4 text-base text-ink-navy/60 sm:text-lg">
            Not another autocomplete plugin. LakshX plans, edits, and runs commands across your repo — with
            the guardrails, the undo button, and the model choice to match how you actually work.
          </motion.p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          className="mt-16 grid gap-6 sm:grid-cols-2"
        >
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              variants={fadeUp}
              className="group relative rounded-3xl border border-ink-navy/[0.07] bg-white/80 p-8 shadow-frame backdrop-blur-sm transition hover:border-lakshx-violet/30 hover:shadow-lg"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-lakshx-violet-active/25 text-lakshx-violet">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="mt-5 font-heading text-lg font-semibold text-ink-navy">{title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-navy/60">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
