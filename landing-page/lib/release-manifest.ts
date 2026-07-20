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

// First real release: CI run 29744226651 (github.com/BeastxD7/LakshX-IDE/
// actions/runs/29744226651), built from this exact commit — includes the
// hosted-model picker fix (show all models, label+disable by plan), the
// Royal mode dropdown contrast fix, the DB schema canvas pan/zoom, and
// this update mechanism itself. macOS artifact re-packaged as a real .dmg
// locally (create-dmg.ts) from the same commit rather than uploading CI's
// raw .app zip, same as every prior macOS publish — see downloads.ts's
// doc comment for why. No "darwin-arm64" entry in `platforms`: the update
// route hardcodes a 204 for that platform regardless (Squirrel.Mac +
// ad-hoc signing, see the route's own doc comment), so populating it here
// would just be dead data.
export const LATEST_RELEASE: ReleaseManifest = {
  commit: "ae47998cad0dcde09c0c110fc4844b927a38c512",
  productVersion: "2026-07-20",
  timestamp: 1784555188000,
  platforms: {
    "linux-x64": {
      url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-Linux-x64.deb",
      sha256: "3a8a69561bfc26eb4a0107d7679b1639aa42656f31fcb90c4d8975a8c3772fbe",
    },
    "win32-x64": {
      url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-Windows-x64.exe",
      sha256: "118efb0d70038f01e9f7627a68a02c74ad3c51bd0ec0e8fdcee71c6a46220f14",
    },
  },
};
