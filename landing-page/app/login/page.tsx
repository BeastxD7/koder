"use client";

import { useState } from "react";
import Link from "next/link";
import Logo from "../components/Logo";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.24 1.3-1.7 3.8-5.5 3.8-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.2.8 3.9 1.5l2.6-2.5C16.9 3.3 14.7 2.3 12 2.3 6.9 2.3 2.7 6.5 2.7 11.6s4.2 9.3 9.3 9.3c5.4 0 9-3.8 9-9.1 0-.6-.06-1.1-.15-1.6H12z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleGoogleSignIn() {
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/auth/google-signin");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setErrorMsg(data?.error ?? "failed to start sign-in");
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setErrorMsg("network error — try again");
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-[#0a0c12] px-4 text-white">
      <div className="fixed inset-0 -z-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.jpg" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-[#0a0c12]/85" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0c12]/70 via-[#0a0c12]/90 to-[#0a0c12]/95" />
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.05] p-8 backdrop-blur-2xl">
        <div className="mb-6 flex justify-center">
          <Logo variant="light" />
        </div>

        <h1 className="text-center font-heading text-xl font-bold text-white">Sign in to LakshX</h1>
        <p className="mt-2 text-center text-sm text-white/60">Unlocks the free built-in model, quota tracking, and cloud sync.</p>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-[#1f1f1f] shadow-lg transition hover:brightness-95 disabled:opacity-50"
        >
          <GoogleIcon />
          {loading ? "Redirecting…" : "Continue with Google"}
        </button>
        {errorMsg && <p className="mt-3 text-center text-sm text-red-400">{errorMsg}</p>}

        <p className="mt-8 text-center text-xs text-white/35">
          <Link href="/" className="underline decoration-white/20 hover:decoration-white/50">
            Back to lakshx.in
          </Link>
        </p>
      </div>
    </div>
  );
}
