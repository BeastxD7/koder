/**
 * Single source of truth for LakshX download links.
 *
 * CI (`Build LakshX` GitHub Actions workflow) doesn't publish a GitHub
 * Release, so there's no `github.com/.../releases/...` asset to link to.
 * Build artifacts are hosted publicly on Vercel Blob (store
 * `koder-downloads`) instead, uploaded manually from each CI run's build
 * artifacts.
 *
 * Every download button/link in this app MUST read from this object —
 * do not hardcode a URL anywhere else.
 *
 * `macIntel` stays NOT_CONFIGURED_URL: macOS Intel (darwin-x64) was dropped
 * from the CI build matrix (see build.yml), so no Intel artifact exists to
 * link to.
 *
 * The `<DownloadCta>` / manual-download components treat any URL equal to
 * NOT_CONFIGURED_URL as "not wired up yet" and render a visibly disabled
 * "Coming soon" state instead of a live link, so a placeholder can never
 * look like a working download to a real visitor.
 *
 * Cache-busting: these blob paths are STABLE (same filename re-uploaded in
 * place every time we ship a new build), but the blob is served with
 * `Cache-Control: public, max-age=2592000` (30 days, no revalidation). A
 * visitor whose browser cached an older upload at that exact path keeps
 * getting served that stale — possibly since-fixed-and-replaced — file
 * from local disk cache for up to 30 days, with no way to notice. This
 * bit a real user as a spurious "downloaded file is corrupted" report
 * traced back to the *previous* upload's cached bytes, not the current
 * (verified-good) one. Every `url` therefore carries a `?v=` query param;
 * bump it (any distinct string works, e.g. today's date) whenever a new
 * file is uploaded to the same path, so returning visitors are forced to
 * fetch fresh bytes instead of serving a stale disk-cached copy.
 */

export const NOT_CONFIGURED_URL = "#download-not-configured";

export type DownloadKey = "macArm" | "macIntel" | "windows" | "linux";

export interface DownloadTarget {
  /** Human-readable platform label, used in button/link text. */
  label: string;
  /** Short label used in compact secondary pills. */
  shortLabel: string;
  /** Public download URL. NOT_CONFIGURED_URL until real hosting exists. */
  url: string;
}

/** Bump the value for a platform every time a new file is uploaded to its
 * (stable) blob path — see the cache-busting note above. */
const BLOB_VERSION: Record<Exclude<DownloadKey, "macIntel">, string> = {
  // Rebuilt from commit f14a325 (CI run 29749662076) -- all three
  // platforms, including the topbar "Update available" badge and the fix
  // that lets it see a real macOS update (see release-manifest.ts's doc
  // comment). macOS CI only zips the raw .app (see this file's own doc
  // comment above); the .dmg came from the same manual create-dmg.ts run
  // this session already exercised (ad-hoc codesign + dmgbuild), applied
  // to this run's freshly downloaded .app.
  macArm: "2026-07-20-2",
  windows: "2026-07-20-2",
  linux: "2026-07-20-2",
};

const withVersion = (url: string, version: string) => `${url}?v=${version}`;

export const DOWNLOADS: Record<DownloadKey, DownloadTarget> = {
  macArm: {
    label: "macOS (Apple Silicon)",
    shortLabel: "macOS (Apple Silicon)",
    // A real .dmg installer now (drag-to-Applications, matching how every
    // other macOS app is distributed), not a raw .zip of the app bundle --
    // built locally via upstream/build/darwin/create-dmg.ts since CI is
    // currently blocked. See patches/darwin-dmg-title-use-product-name.patch
    // for a real branding bug found while building this (volume title said
    // "VS Code" despite the app inside correctly being LakshX.app).
    url: withVersion("https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-macOS-arm64.dmg", BLOB_VERSION.macArm),
  },
  macIntel: {
    label: "macOS (Intel)",
    shortLabel: "macOS (Intel)",
    url: NOT_CONFIGURED_URL, // no Intel build in the CI matrix (dropped; see build.yml)
  },
  windows: {
    label: "Windows",
    shortLabel: "Windows",
    // A real installer .exe now (CI build 29410662610), not the old zip of
    // loose files — see .github/workflows/build.yml's Windows installer fix.
    // Filename changed from Koder-Windows-x64-Setup.exe to LakshX-Windows-x64.exe
    // as part of the rebrand — this is a NEW blob path, not a re-upload to the
    // old one, so the old path is orphaned (harmless, just unreferenced) rather
    // than overwritten.
    url: withVersion("https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-Windows-x64.exe", BLOB_VERSION.windows),
  },
  linux: {
    label: "Linux (.deb)",
    shortLabel: "Linux",
    // A real .deb package (CI's vscode-linux-x64-prepare-deb/build-deb gulp
    // tasks), not a tar.gz of loose files — same "download, double-click to
    // install" experience as the Windows/macOS installers above.
    url: withVersion("https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/LakshX-Linux-x64.deb", BLOB_VERSION.linux),
  },
};

/** True when a given download target has not been wired up to a real URL yet. */
export function isDownloadConfigured(target: DownloadTarget): boolean {
  return target.url !== NOT_CONFIGURED_URL;
}
