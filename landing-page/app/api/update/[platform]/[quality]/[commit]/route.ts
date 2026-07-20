import { NextRequest } from "next/server";
import { LATEST_RELEASE } from "../../../../../../lib/release-manifest";

export const runtime = "nodejs";

/**
 * The endpoint VSCode's built-in updater polls directly (createUpdateURL,
 * upstream/src/vs/platform/update/electron-main/abstractUpdateService.ts) —
 * `product.overrides.json`'s `updateUrl` points here. URL shape and every
 * response contract below (204 = no update, else IUpdate JSON) is fixed by
 * that client code, not something this route gets to redesign; see
 * upstream/src/vs/platform/update/common/update.ts's `IUpdate` interface
 * for the exact JSON shape expected.
 *
 * `:commit` is the requesting client's OWN build identity — round-tripped
 * from `product.json.commit`, which BUILD_SOURCEVERSION (build.yml /
 * OS-Build/*.sh|.ps1) stamps with the LakshX repo's real SHA specifically
 * so this comparison means something (upstream/'s own commit is constant
 * across every LakshX build otherwise). `:platform`/`:quality` are
 * unused beyond routing — there's only ever one `quality` ("stable") and
 * `:platform` is read from the path via `params` below, not needed
 * separately.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string; quality: string; commit: string }> }) {
  const { platform, commit } = await params;

  // This ONE endpoint is polled by two different callers on macOS, and
  // they need different answers:
  //   1. VS Code's own native updater (electron.autoUpdater / Squirrel.Mac,
  //      updateService.darwin.ts) — it validates the signing identity
  //      between the installed and downloaded app before applying, and our
  //      .dmg is ad-hoc signed only (`codesign --force --deep -s -`, no
  //      real Developer ID/Team ID). Handing it a real update here risks
  //      it showing the user an "update is improperly signed" error while
  //      trying to silently apply — so it always gets 204.
  //   2. product/lakshx-chat's own badge check (extension.js's
  //      checkForLakshxUpdate) — it never asks VS Code to silently apply
  //      anything; its click handler opens the download page in a browser
  //      instead (same graceful fallback Linux's own updater already has
  //      built in — see updateService.linux.ts's doDownloadUpdate). Safe
  //      to tell the truth to.
  // Distinguished by a header only the extension's own fetch() call sends
  // (getUpdateRequestHeaders() in abstractUpdateService.ts building
  // Squirrel's real request never includes anything like it) — not by
  // User-Agent sniffing, which is easy to get subtly wrong either
  // direction.
  const isLakshxBadgeCheck = req.headers.get("x-lakshx-badge-check") === "1";
  const platformKnown = platform !== "darwin-arm64" || isLakshxBadgeCheck;
  const platformEntry = platformKnown ? LATEST_RELEASE.platforms[platform as keyof typeof LATEST_RELEASE.platforms] : undefined;

  if (!platformEntry || commit === LATEST_RELEASE.commit) {
    return new Response(null, { status: 204 });
  }

  return Response.json({
    version: LATEST_RELEASE.commit,
    productVersion: LATEST_RELEASE.productVersion,
    timestamp: LATEST_RELEASE.timestamp,
    url: platformEntry.url,
    ...(platformEntry.sha256 ? { sha256hash: platformEntry.sha256 } : {}),
  });
}
