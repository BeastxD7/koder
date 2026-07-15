"use client";

import { useEffect, useState } from "react";
import { Apple, Monitor, Terminal, Download } from "lucide-react";
import CtaButton from "./CtaButton";
import { DOWNLOADS, isDownloadConfigured, type DownloadKey } from "@/lib/downloads";
import { detectPlatform, type DetectedPlatform } from "@/lib/detect-platform";

const PLATFORM_ICON: Record<DownloadKey, typeof Apple> = {
  macArm: Apple,
  macIntel: Apple,
  windows: Monitor,
  linux: Terminal,
};

/**
 * The primary "Download for {OS}" CTA. Server-rendered state is always the
 * neutral "unknown" state (no `navigator` on the server) — detection runs
 * once on mount in an effect, so there is no hydration mismatch: first
 * client render matches the server render, then upgrades a beat later.
 */
export default function DownloadCta() {
  const [platform, setPlatform] = useState<DetectedPlatform>("unknown");

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const primaryKey: DownloadKey | null =
    platform === "mac" ? "macArm" : platform === "windows" ? "windows" : platform === "linux" ? "linux" : null;

  const primaryTarget = primaryKey ? DOWNLOADS[primaryKey] : null;
  const primaryConfigured = primaryTarget ? isDownloadConfigured(primaryTarget) : false;
  const PrimaryIcon = primaryKey ? PLATFORM_ICON[primaryKey] : Download;

  const intelConfigured = isDownloadConfigured(DOWNLOADS.macIntel);

  return (
    <div className="flex flex-col items-center gap-3">
      {primaryTarget ? (
        <CtaButton
          variant="primary"
          size="lg"
          href={primaryTarget.url}
          disabled={!primaryConfigured}
          className="min-w-[15rem]"
        >
          <PrimaryIcon className="h-5 w-5" aria-hidden="true" />
          Download for {platform === "mac" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}
        </CtaButton>
      ) : platform === "unsupported" ? (
        <p className="max-w-xs text-center text-sm text-white/70">
          LakshX is available for macOS, Windows, and Linux — visit from your computer to download.
        </p>
      ) : null}

      {!primaryConfigured && primaryTarget && (
        <p className="text-xs text-white/70">Downloads aren&rsquo;t hosted yet — coming soon.</p>
      )}

      {platform === "mac" && (
        <a
          href={intelConfigured ? DOWNLOADS.macIntel.url : undefined}
          aria-disabled={!intelConfigured}
          className={`text-sm underline decoration-white/40 underline-offset-4 transition ${
            intelConfigured ? "text-white/80 hover:text-white" : "pointer-events-none text-white/40"
          }`}
        >
          Not on Apple Silicon? Download for Intel
        </a>
      )}
    </div>
  );
}
