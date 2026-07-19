/**
 * Rich violet gradient wash — the SAME brand accent as the hero itself
 * (Logo.tsx's `#9d7fff`/`#6a48f0` spark gradient, globals.css's
 * `--color-lakshx-violet`/`-active`), just lighter/airier so body text
 * stays readable on a near-white canvas.
 *
 * Rendered EXACTLY ONCE, as the first child of the single shared wrapper in
 * page.tsx that contains Features+Pricing+SiteFooter together — never once
 * per section. Blobs are spread across top/middle/bottom (not just the top)
 * so the wash still reads as continuous over that wrapper's full combined
 * height, with no per-section background color or overflow boundary to
 * create a seam at each component's edge.
 */
export default function SectionGlow() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-1/4 -top-1/4 h-[40rem] w-[40rem] rounded-full bg-lakshx-violet-active/45 blur-[110px]" />
      <div className="absolute -right-1/4 top-[10%] h-[36rem] w-[36rem] rounded-full bg-[#9d7fff]/30 blur-[110px]" />
      <div className="absolute left-1/3 top-[45%] h-[42rem] w-[42rem] -translate-x-1/2 rounded-full bg-lakshx-violet/25 blur-[120px]" />
      <div className="absolute -right-1/4 top-[70%] h-[38rem] w-[38rem] rounded-full bg-lakshx-violet-active/35 blur-[110px]" />
      <div className="absolute -left-1/4 top-[95%] h-[36rem] w-[36rem] rounded-full bg-[#9d7fff]/30 blur-[110px]" />
    </div>
  );
}
