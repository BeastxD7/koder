import { signInWithGoogle } from "./actions";

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

export default function AdminLoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0c12] px-4 text-white">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.05] p-8 backdrop-blur-2xl">
        <h1 className="text-center font-heading text-xl font-bold text-white">LakshX Admin</h1>
        <p className="mt-2 text-center text-sm text-white/60">Sign in with the founder account to view usage and costs.</p>

        <form action={signInWithGoogle} className="mt-6">
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-[#1f1f1f] shadow-lg transition hover:brightness-95"
          >
            <GoogleIcon />
            Continue with Google
          </button>
        </form>
      </div>
    </div>
  );
}
