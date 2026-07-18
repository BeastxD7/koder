"use client";

import { useActionState } from "react";
import { requestAdminMagicLink, type MagicLinkState } from "./actions";

const initialState: MagicLinkState = { status: "idle" };

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(requestAdminMagicLink, initialState);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0c12] px-4 text-white">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.05] p-8 backdrop-blur-2xl">
        <h1 className="text-center font-heading text-xl font-bold text-white">LakshX Admin</h1>
        <p className="mt-2 text-center text-sm text-white/60">Sign in with the founder account to view usage and costs.</p>

        {state.status === "sent" ? (
          <p className="mt-6 text-center text-sm text-white/70">
            Sign-in link sent to <span className="text-white">{state.email}</span>. Open it on this device.
          </p>
        ) : (
          <form action={formAction} className="mt-6 flex flex-col gap-3">
            <input
              type="email"
              name="email"
              required
              placeholder="you@example.com"
              className="rounded-lg border border-white/15 bg-black/30 px-4 py-2.5 text-sm text-white placeholder-white/35 outline-none focus:border-lakshx-violet/50"
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-gradient-to-r from-lakshx-violet to-lakshx-violet-active px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-lakshx-violet/30 transition hover:brightness-110 disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send sign-in link"}
            </button>
            {state.status === "error" && <p className="text-center text-sm text-red-400">{state.message}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
