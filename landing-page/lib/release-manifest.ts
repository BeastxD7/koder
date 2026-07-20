import releaseData from "./release-data.json";

/**
 * Single source of truth for the "latest LakshX build" the in-app updater
 * (app/api/update/[platform]/[quality]/[commit]/route.ts) checks against.
 * The actual DATA lives in release-data.json — a machine-written file, kept
 * separate from this one specifically so the publish pipeline (scripts/
 * publish-release.mjs, run by .github/workflows/build.yml's `publish` job)
 * can safely overwrite it on every release without touching hand-written
 * prose anywhere in this file.
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

export const LATEST_RELEASE: ReleaseManifest = releaseData;
