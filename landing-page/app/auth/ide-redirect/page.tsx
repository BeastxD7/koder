"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Logo from "../../components/Logo";

const DEEP_LINK_TARGET = "lakshx://lakshx.lakshx-chat/auth-callback";

/**
 * Relay page for the IDE's Google OAuth flow. Supabase's own callback used
 * to redirect the browser straight to `lakshx://...#access_token=...` — a
 * custom scheme with nothing for the browser to render, so the tab was left
 * looking permanently stuck on a loading state even though the sign-in had
 * already succeeded (the extension's URI handler received the tokens fine).
 * This page exists purely to give that browser tab a real page to show:
 * it forwards the token fragment to the lakshx:// deep link itself, then
 * displays a clear confirmation instead of leaving the user guessing.
 */
export default function IdeRedirectPage() {
  const [status, setStatus] = useState<"redirecting" | "manual" | "error">("redirecting");
  const [deepLink, setDeepLink] = useState("");

  useEffect(() => {
    const hash = window.location.hash; // includes the leading '#', never sent to any server
    if (!hash || !hash.includes("access_token")) {
      setStatus("error");
      return;
    }
    const target = `${DEEP_LINK_TARGET}${hash}`;
    setDeepLink(target);
    window.location.href = target;
    // Browsers don't reliably report whether a custom-scheme handoff actually
    // launched the target app — no consistent success/failure signal exists
    // to wait for. Show the manual fallback shortly after either way, rather
    // than leaving the user on a bare "opening..." message with no escape
    // hatch if the automatic attempt silently didn't fire.
    const t = setTimeout(() => setStatus("manual"), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-[#0a0c12] px-4 text-white">
      <div className="fixed inset-0 -z-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.jpg" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-[#0a0c12]/85" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0c12]/70 via-[#0a0c12]/90 to-[#0a0c12]/95" />
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.05] p-8 text-center backdrop-blur-2xl">
        <div className="mb-6 flex justify-center">
          <Logo variant="light" />
        </div>

        {status === "error" ? (
          <>
            <h1 className="font-heading text-xl font-bold text-white">Something went wrong</h1>
            <p className="mt-2 text-sm text-white/60">
              No sign-in information was found in this link. Head back to the IDE and try signing in again.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-heading text-xl font-bold text-white">You&rsquo;re signed in!</h1>
            <p className="mt-2 text-sm text-white/60">
              {status === "redirecting" ? "Opening LakshX…" : "If LakshX didn't open automatically:"}
            </p>
            {status === "manual" && (
              <a
                href={deepLink}
                className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-[#1f1f1f] shadow-lg transition hover:brightness-95"
              >
                Open LakshX
              </a>
            )}
          </>
        )}

        <p className="mt-8 text-center text-xs text-white/35">
          <Link href="/" className="underline decoration-white/20 hover:decoration-white/50">
            Back to lakshx.in
          </Link>
        </p>
      </div>
    </div>
  );
}
