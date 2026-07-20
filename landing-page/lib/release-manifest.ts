/**
 * Single source of truth for the "latest LakshX build" the in-app updater
 * (app/api/update/[platform]/[quality]/[commit]/route.ts) checks against —
 * same hand-maintained-on-publish pattern as lib/downloads.ts's
 * BLOB_VERSION, and updated in the same step: every time a fresh build is
 * uploaded to the koder-downloads blob store, bump this alongside it.
 *
 * `commit` MUST match the full 40-char BUILD_SOURCEVERSION the build was
 * stamped with (.github/workflows/build.yml's Package step, or the
 * equivalent OS-Build/*.sh|.ps1 local-build step) — VSCode's own commit
 * (upstream/'s pinned code-oss checkout) is useless here since it's
 * constant across every LakshX build; BUILD_SOURCEVERSION is what makes
 * this a real per-release identifier. The update-check route 204s when the
 * requesting client's own commit already equals this value.
 */
export interface ReleaseManifest {
  /** Full 40-char git SHA of the LakshX repo commit this build was made from. */
  commit: string;
  /** Display version shown in the "update available" UI — not a strict semver, just date-based. */
  productVersion: string;
  /** Unix ms timestamp of the build. */
  timestamp: number;
  platforms: {
    "darwin-arm64"?: { url: string; sha256?: string };
    "linux-x64"?: { url: string; sha256?: string };
    "win32-x64"?: { url: string; sha256?: string };
  };
}

// CI run 29749662076 (github.com/BeastxD7/LakshX-IDE/actions/runs/
// 29749662076), built from this exact commit — adds the topbar "Update
// available" badge itself, plus the fix that lets it actually see a real
// darwin-arm64 update: the route's platform-known check now special-cases
// darwin on the x-lakshx-badge-check header (see route.ts's doc comment)
// instead of hardcoding 204 unconditionally, so THIS entry is what makes
// that path do anything for the first time. Squirrel.Mac (no header) still
// always gets 204 regardless of what's here — the badge's own click
// handler opens this url in a browser rather than attempting a silent
// apply. macOS artifact re-packaged as a real .dmg locally (create-dmg.ts)
// from the same commit rather than uploading CI's raw .app zip, same as
// every prior macOS publish — see downloads.ts's doc comment for why.
export const LATEST_RELEASE: ReleaseManifest = {
  commit: "f14a3254fe149c495349bc801798e5ca48217b40",
  productVersion: "2026-07-20",
  timestamp: 1784561025000,
  platforms: {
    "darwin-arm64": {
      url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-macOS-arm64.dmg",
      sha256: "faaccf8d5cee394b0a2e36136007cff119fddd30bf41f6d0b9249af294c72aeb",
    },
    "linux-x64": {
      url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-Linux-x64.deb",
      sha256: "020d37ff376dfcef4ad85f58bc0b57d3c0a5489204596c665c5920f33f3612b3",
    },
    "win32-x64": {
      url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-Windows-x64.exe",
      sha256: "546b5e9bea6b4099be27d1b908c16f4ef09e1a29c4f0cdbab6f72f953bd507e9",
    },
  },
};
