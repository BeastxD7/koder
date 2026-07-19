import Hero from "./components/Hero";
import Features from "./components/Features";
import Pricing from "./components/Pricing";
import SiteFooter from "./components/SiteFooter";
import SectionGlow from "./components/SectionGlow";

export default function Home() {
  return (
    <main>
      <div id="top">
        <Hero />
      </div>

      {/* One continuous background for everything below the hero — Features,
          Pricing, and SiteFooter render as plain content inside this single
          wrapper (no per-component bg color/overflow-hidden/glow of their
          own), so there's no visible seam at each component's boundary. */}
      <div className="relative isolate overflow-hidden bg-white">
        {/* Seam treatment: a short, low-opacity fade that softens the hard
            pixel edge where the hero's photo ends, without reading as its
            own dark band — the violet SectionGlow below picks up
            immediately, so the eye moves from photo straight into the
            wash, not through a separate dark "dead zone" first. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-16 bg-gradient-to-b from-black/25 to-transparent sm:h-20"
        />
        <SectionGlow />

        <Features />
        <Pricing />
        <SiteFooter />
      </div>
    </main>
  );
}
