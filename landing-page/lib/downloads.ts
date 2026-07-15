/**
 * Single source of truth for Koder download links.
 *
 * The Koder GitHub repo is private, so plain `github.com/.../releases/...`
 * download links will NOT work for anonymous visitors (private repos block
 * unauthenticated downloads of both source and release assets). Build
 * artifacts are hosted publicly on Vercel Blob (store `koder-downloads`)
 * instead, uploaded from the `Build Koder` GitHub Actions workflow's
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

export const DOWNLOADS: Record<DownloadKey, DownloadTarget> = {
  macArm: {
    label: "macOS (Apple Silicon)",
    shortLabel: "macOS (Apple Silicon)",
    url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/Koder-macOS-arm64.zip",
  },
  macIntel: {
    label: "macOS (Intel)",
    shortLabel: "macOS (Intel)",
    url: NOT_CONFIGURED_URL, // no Intel build in the CI matrix (dropped; see build.yml)
  },
  windows: {
    label: "Windows",
    shortLabel: "Windows",
    url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/Koder-Windows-x64.zip",
  },
  linux: {
    label: "Linux",
    shortLabel: "Linux",
    url: "https://qflnh9roir6uolgc.public.blob.vercel-storage.com/koder/Koder-Linux-x64.tar.gz",
  },
};

/** True when a given download target has not been wired up to a real URL yet. */
export function isDownloadConfigured(target: DownloadTarget): boolean {
  return target.url !== NOT_CONFIGURED_URL;
}
