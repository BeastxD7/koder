import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const alt = "LakshX — India's #1 Agentic Coding IDE";
export const size = { width: 1200, height: 630 };
export const contentType = "image/jpeg";

// Mirrors the real Hero component's composition (background photo + dark
// scrim + centered logo/badge/headline) at OG dimensions, so link previews
// (Slack, Twitter, iMessage, WhatsApp, Discord) look like the actual site
// rather than a generic branded card. The background photo is read from
// /public and inlined as a base64 data URI — ImageResponse (Satori) can't
// reliably fetch relative URLs, and doesn't support gradient/clip-text
// fills, so the headline here is solid white instead of the page's
// gradient treatment. The logo mark is the same inline spark-glyph
// SVG used by <Logo> (not a raster asset), so it stays in sync with the
// on-page logo automatically.
export default async function OgImage() {
  const heroBg = await readFile(join(process.cwd(), "public/hero-bg.jpg"));
  const heroBgSrc = `data:image/jpeg;base64,${heroBg.toString("base64")}`;

  const imageResponse = new ImageResponse(
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
          <svg width="40" height="40" viewBox="0 0 1024 1024">
            <defs>
              <linearGradient id="og-mark-bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#15181f" />
                <stop offset="1" stopColor="#0a0c10" />
              </linearGradient>
              <linearGradient id="og-mark-spark" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#9d7fff" />
                <stop offset="1" stopColor="#6a48f0" />
              </linearGradient>
            </defs>
            <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#og-mark-bg)" />
            <rect
              x="64"
              y="64"
              width="896"
              height="896"
              rx="200"
              fill="none"
              stroke="#7c5cff"
              strokeOpacity="0.35"
              strokeWidth="8"
            />
            <path
              d="M512 200 L568 424 L768 320 L616 496 L824 512 L616 528 L768 704 L568 600 L512 824 L456 600 L256 704 L408 528 L200 512 L408 496 L256 320 L456 424 Z"
              fill="url(#og-mark-spark)"
            />
            <circle cx="512" cy="512" r="56" fill="#0a0c10" />
            <circle cx="512" cy="512" r="34" fill="#c8b6ff" />
          </svg>
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

  // `ImageResponse` (Satori + resvg) only ever rasterizes to PNG, with no
  // quality/format control. Compositing a full-bleed photo losslessly into
  // a 1200x630 canvas produces a ~1.3MB PNG — several times larger than the
  // 472KB source JPEG. That weight is fine for Discord/Twitter but has been
  // reported to cause WhatsApp's link-preview crawler to silently drop the
  // image. Re-encode to JPEG (photos compress far better lossy than
  // lossless) to keep the served OG image well under ~200KB.
  const pngBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const jpegBuffer = await sharp(pngBuffer).jpeg({ quality: 82, mozjpeg: true }).toBuffer();

  return new Response(new Uint8Array(jpegBuffer), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, immutable, no-transform, max-age=31536000",
    },
  });
}
