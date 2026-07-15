"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import Logo from "./Logo";
import DownloadCta from "./DownloadCta";

const HEADLINE = "An agentic IDE, not just autocomplete.";
const SUBHEAD =
  "LakshX is a VS Code fork with a real coding agent inside. It plans, edits, and runs commands across your repo, at whatever safety level you choose.";

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
};

// No card — text sits directly on the photo, readable via a uniform dark
// scrim + white text, same pattern as the reference hero.
export default function Hero() {
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden px-6 py-6 sm:px-10 sm:py-8">
      <Image
        src="/hero-bg.jpg"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      <div className="absolute inset-0 bg-black/35" />

      <div className="relative flex items-center justify-between">
        <Logo variant="light" />
      </div>

      <div className="relative flex flex-1 items-center justify-center py-10">
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="flex w-full max-w-2xl flex-col items-center gap-6 text-center"
        >
          <motion.span
            variants={fadeUp}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-4 py-1.5 text-sm text-white backdrop-blur-sm"
          >
            <span aria-hidden="true" className="text-lakshx-violet-active">
              ✦
            </span>
            India&rsquo;s #1 Agentic Coding IDE
          </motion.span>

          <motion.h1
            variants={fadeUp}
            className="text-balance bg-gradient-to-b from-white via-white to-lakshx-violet-active bg-clip-text font-display text-4xl italic font-bold leading-[1.1] tracking-tight text-transparent drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-5xl sm:leading-[1.08] md:text-6xl"
          >
            {HEADLINE}
          </motion.h1>

          <motion.p variants={fadeUp} className="max-w-lg text-base text-white/80 sm:text-lg">
            {SUBHEAD}
          </motion.p>

          <motion.div variants={fadeUp} className="mt-2 w-full">
            <DownloadCta />
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
