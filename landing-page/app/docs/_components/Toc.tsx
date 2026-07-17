"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface Heading {
  id: string;
  text: string;
  level: number;
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

/**
 * Right-hand "On this page" table of contents. It reads the rendered
 * article's h2/h3 headings from the DOM after mount (assigning ids where
 * missing), then highlights the section currently in view via
 * IntersectionObserver. Re-runs whenever the route changes.
 *
 * `articleId` defaults to "docs-article" (DocArticle's fixed id) so every
 * existing docs page keeps working unchanged; pass a different id to scan
 * some other container (e.g. the changelog page's own article shell).
 */
export default function Toc({ articleId = "docs-article" }: { articleId?: string }) {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const article = document.getElementById(articleId);
    if (!article) return;
    const nodes = Array.from(article.querySelectorAll("h2, h3")) as HTMLElement[];
    const found: Heading[] = nodes.map((node) => {
      if (!node.id) node.id = slugify(node.textContent ?? "");
      return { id: node.id, text: node.textContent ?? "", level: node.tagName === "H2" ? 2 : 3 };
    });
    setHeadings(found);
    setActiveId(found[0]?.id ?? "");

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: [0, 1] }
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [pathname, articleId]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/40">On this page</p>
      <ul className="space-y-2 border-l border-white/10">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={`-ml-px block border-l-2 py-0.5 transition ${
                h.level === 3 ? "pl-6" : "pl-4"
              } ${
                activeId === h.id
                  ? "border-lakshx-violet-active font-medium text-white"
                  : "border-transparent text-white/50 hover:text-white/85"
              }`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
