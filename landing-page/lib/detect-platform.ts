/**
 * Client-side OS detection for the "Download for {OS}" button.
 *
 * Real limits, on purpose, not glossed over:
 * - Android UAs also contain "Linux" — Android MUST be checked before Linux
 *   or every Android visitor gets mis-detected as a Linux desktop user.
 * - macOS Apple Silicon vs Intel is NOT reliably detectable from the browser.
 *   Modern Safari/Chrome normalize `navigator.userAgent` /
 *   `navigator.platform` for privacy, so both architectures report as
 *   "Mac". We default to Apple Silicon (arm64) since that's the
 *   overwhelmingly common current Mac, and surface an Intel link right next
 *   to the primary button rather than pretending we can tell them apart.
 * - Anything we don't recognize (mobile, unusual UAs) must NOT get a
 *   confidently-wrong OS-specific button — it falls back to "unsupported",
 *   which the UI renders as a neutral "view all downloads" prompt.
 */

export type DetectedPlatform =
  | "unknown" // detection hasn't run yet (SSR / not-yet-mounted)
  | "mac"
  | "windows"
  | "linux"
  | "unsupported"; // mobile or unrecognized — no confident desktop OS guess

export function detectPlatform(): DetectedPlatform {
  if (typeof navigator === "undefined") return "unknown";

  const ua = navigator.userAgent ?? "";
  const platform = navigator.platform ?? "";
  const signal = `${ua} ${platform}`;

  // Android UAs contain "Linux" too — must be excluded before the Linux check.
  if (/Android/i.test(signal)) return "unsupported";
  if (/Win/i.test(signal)) return "windows";

  if (/Mac/i.test(signal)) {
    // iPadOS Safari (default "Request Desktop Website" mode since iPadOS 13)
    // reports a Macintosh UA indistinguishable from a real Mac. Multi-touch
    // support is the standard heuristic to catch that case rather than
    // pointing an iPad at a desktop .dmg download.
    const isLikelyIpad = typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
    return isLikelyIpad ? "unsupported" : "mac";
  }

  if (/Linux/i.test(signal)) return "linux";

  return "unsupported";
}
