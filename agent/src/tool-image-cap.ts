/**
 * Size cap for a tool's `image` attachment (see tools.ts's
 * `ToolImageAttachment`) before it crosses the ACP wire as a
 * `lakshx/tool_image` notification (server.ts). Pulled into its own module
 * — rather than living inline in server.ts, which `connect()`s to real
 * stdio at import time (see the bottom of server.ts) and is therefore never
 * import-tested directly — so this one piece of size-cap logic can be unit
 * tested in isolation.
 *
 * `browser_preview` screenshots are a viewport-sized PNG — typically a few
 * hundred KB, occasionally a couple MB for a content-heavy page. 2MB (raw,
 * pre-base64) comfortably covers the normal case while still bounding the
 * worst case: base64 inflates by ~4/3, so a 2MB screenshot is a ~2.7MB
 * notification payload, not unbounded.
 */
export const MAX_TOOL_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Returns `base64` unchanged if its decoded size is within `maxBytes`,
 * `undefined` otherwise — the caller drops the inline payload gracefully
 * (still has the on-disk `path` to offer an "open" affordance) rather than
 * flooding the wire or crashing anything.
 */
export function capToolImageBase64(base64: string, maxBytes: number = MAX_TOOL_IMAGE_BYTES): string | undefined {
  if (base64.length === 0) return base64;
  // 4 base64 chars encode 3 raw bytes — but trailing `=`/`==` padding
  // encodes fewer than 3 bytes in the final group, so it must be subtracted
  // out for an EXACT decoded length. Without this, a naive `len*3/4`
  // overcounts by up to 2 bytes whenever the input is padded, which can
  // wrongly reject an image sitting exactly at (or just under) the cap.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const rawBytes = (base64.length / 4) * 3 - padding;
  return rawBytes > maxBytes ? undefined : base64;
}
