/**
 * Single source of truth for the docs navigation.
 *
 * Kept as plain data so the sidebar, the mobile drawer, and the prev/next
 * pager all render from the same ordered list — add a page here and it shows
 * up everywhere. `href` is the full route under /docs.
 */

export interface DocPage {
  title: string;
  href: string;
  /** Short one-liner shown under the title on the docs index cards. */
  blurb?: string;
  /** Optional pill (e.g. "Coming soon") rendered next to the title. */
  badge?: string;
}

export interface DocGroup {
  label: string;
  pages: DocPage[];
}

export const DOCS_NAV: DocGroup[] = [
  {
    label: "Getting Started",
    pages: [
      { title: "Overview", href: "/docs", blurb: "What LakshX is and how the docs are organized." },
      { title: "Installation", href: "/docs/installation", blurb: "Download and run LakshX on macOS, Windows, or Linux." },
      { title: "Sign In & Models", href: "/docs/sign-in", blurb: "The free hosted model, or bring your own provider key." },
    ],
  },
  {
    label: "Chat & Agent",
    pages: [
      { title: "The Chat Panel", href: "/docs/chat", blurb: "Talk to the agent, attach files, @-mention, and steer a run." },
      { title: "Feedback & Diagnostics", href: "/docs/feedback", blurb: "Thumbs, retry, the error Report button, and the diagnostic report." },
    ],
  },
  {
    label: "Modes & Royal Mode",
    pages: [
      { title: "Agent Modes", href: "/docs/modes", blurb: "Review, Approve, Auto, and Royal — how much you let the agent do." },
      { title: "Royal Mode", href: "/docs/royal-mode", blurb: "Full autonomy with a hard safety floor and consent gate." },
    ],
  },
  {
    label: "Slash Commands",
    pages: [
      { title: "Slash Commands", href: "/docs/slash-commands", blurb: "Type / in the composer for built-ins and your own commands." },
    ],
  },
  {
    label: "Browser & Visual Verification",
    pages: [
      { title: "Interactive Browser", href: "/docs/browser", blurb: "The agent drives a real browser and sees the screenshots." },
    ],
  },
  {
    label: "Rewind & Checkpoints",
    pages: [
      { title: "Conversation Rewind", href: "/docs/rewind", blurb: "Accept or reject any point in the conversation." },
      { title: "Checkpoints & Undo", href: "/docs/checkpoints", blurb: "Per-message, per-file, and session-wide undo with a diff view." },
    ],
  },
  {
    label: "Databases",
    pages: [
      { title: "Database Visualization", href: "/docs/databases", blurb: "ER diagrams for MongoDB, PostgreSQL, MySQL, and SQLite." },
      { title: "db_query & Data Browse", href: "/docs/db-query", blurb: "Let the agent read real rows — read-only, opt-in per connection." },
    ],
  },
  {
    label: "Code Graph",
    pages: [
      { title: "Code Call Graph", href: "/docs/code-graph", blurb: "A native map of who-calls-what across your codebase." },
    ],
  },
  {
    label: "Music",
    pages: [
      { title: "LakshX FM", href: "/docs/music", blurb: "Free background music and cheeky commentary while you code." },
    ],
  },
  {
    label: "Voice",
    pages: [
      { title: "Voice Mode", href: "/docs/voice", blurb: "Offline push-to-talk dictation straight into the composer." },
    ],
  },
  {
    label: "Remote Access",
    pages: [
      { title: "Remote Access", href: "/docs/remote-access", blurb: "Pair your phone by QR and drive the agent from anywhere." },
    ],
  },
  {
    label: "Building from Source",
    pages: [
      { title: "Building from Source", href: "/docs/building", blurb: "Produce native installers with the OS-Build scripts." },
    ],
  },
];

/** Flat, ordered list of every page — used by the prev/next pager. */
export const DOCS_FLAT: DocPage[] = DOCS_NAV.flatMap((g) => g.pages);

export function adjacentPages(href: string): { prev: DocPage | null; next: DocPage | null } {
  const i = DOCS_FLAT.findIndex((p) => p.href === href);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? DOCS_FLAT[i - 1] : null,
    next: i < DOCS_FLAT.length - 1 ? DOCS_FLAT[i + 1] : null,
  };
}
