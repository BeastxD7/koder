"use client";

import { useState } from "react";
import Link from "next/link";
import Logo from "../components/Logo";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");
    try {
      const res = await fetch("/api/auth/request-magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data?.error ?? "something went wrong");
        setStatus("error");
        return;
      }
      setStatus("sent");
    } catch {
      setErrorMsg("network error — try again");
      setStatus("error");
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

        {status === "sent" ? (
          <div className="text-center">
            <h1 className="font-heading text-xl font-bold text-white">Check your email</h1>
            <p className="mt-3 text-sm leading-relaxed text-white/65">
              We sent a sign-in link to <span className="text-white">{email}</span>. Open it on this device — it'll hand you
              straight back to LakshX.
            </p>
            <button
              type="button"
              onClick={() => setStatus("idle")}
              className="mt-6 text-sm text-lakshx-violet-active underline decoration-white/30 hover:decoration-white/70"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <h1 className="text-center font-heading text-xl font-bold text-white">Sign in to LakshX</h1>
            <p className="mt-2 text-center text-sm text-white/60">
              Unlocks the free built-in model, quota tracking, and cloud sync.
            </p>
            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="rounded-lg border border-white/15 bg-black/30 px-4 py-2.5 text-sm text-white placeholder-white/35 outline-none focus:border-lakshx-violet/50"
              />
              <button
                type="submit"
                disabled={status === "sending"}
                className="rounded-lg bg-gradient-to-r from-lakshx-violet to-lakshx-violet-active px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-lakshx-violet/30 transition hover:brightness-110 disabled:opacity-50"
              >
                {status === "sending" ? "Sending…" : "Send sign-in link"}
              </button>
              {status === "error" && <p className="text-center text-sm text-red-400">{errorMsg}</p>}
            </form>
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
