import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "LakshX — India's #1 Agentic Coding IDE";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Mirrors the real Hero component's composition (background photo + dark
// scrim + centered logo/badge/headline) at OG dimensions, so link previews
// (Slack, Twitter, iMessage, WhatsApp, Discord) look like the actual site
// rather than a generic branded card. Assets are read from /public and
// inlined as base64 data URIs — ImageResponse (Satori) can't reliably
// fetch relative URLs, and doesn't support gradient/clip-text fills, so the
// headline here is solid white instead of the page's gradient treatment.
export default async function OgImage() {
  const [heroBg, mark] = await Promise.all([
    readFile(join(process.cwd(), "public/hero-bg.jpg")),
    readFile(join(process.cwd(), "public/lakshx-mark.png")),
  ]);
  const heroBgSrc = `data:image/jpeg;base64,${heroBg.toString("base64")}`;
  const markSrc = `data:image/png;base64,${mark.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={heroBgSrc}
          width={1200}
          height={630}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "1200px",
            height: "630px",
            objectFit: "cover",
          }}
        />

        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            backgroundColor: "rgba(0,0,0,0.45)",
          }}
        />

        {/* Logo, top-left — mirrors Hero.tsx's top row */}
        <div
          style={{
            position: "absolute",
            top: 44,
            left: 56,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={markSrc}
            width={36}
            height={36}
            style={{ borderRadius: 9, width: "36px", height: "36px" }}
          />
          <span style={{ fontSize: 26, fontWeight: 700, color: "#ffffff", letterSpacing: "-0.02em" }}>
            LakshX
          </span>
        </div>

        {/* Centered content — badge, headline, subhead, mirrors Hero.tsx */}
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 100px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.25)",
              backgroundColor: "rgba(255,255,255,0.1)",
              padding: "10px 22px",
              fontSize: 22,
              color: "#ffffff",
              marginBottom: 28,
            }}
          >
            <span style={{ color: "#c8b6ff" }}>&bull;</span>
            <span>India&rsquo;s #1 Agentic Coding IDE</span>
          </div>

          <div
            style={{
              display: "flex",
              textAlign: "center",
              fontSize: 66,
              fontWeight: 700,
              lineHeight: 1.12,
              letterSpacing: "-0.02em",
              color: "#ffffff",
              maxWidth: 920,
            }}
          >
            An agentic IDE, not just autocomplete.
          </div>

          <div
            style={{
              display: "flex",
              textAlign: "center",
              marginTop: 22,
              fontSize: 26,
              color: "rgba(255,255,255,0.8)",
              maxWidth: 760,
            }}
          >
            LakshX is a VS Code fork with a real coding agent inside.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
