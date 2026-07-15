// "What's New" panel data — a genuine, user-facing changelog curated from
// this repo's actual git history (see extension.js's whatsNewBtn/whatsNewPanel
// and media/panel.js's showWhatsNew()). Every entry here must trace back to
// a real commit/feature; do not add aspirational or planned-but-unshipped
// items.
//
// Shape: { date: "YYYY-MM-DD", title: string, description: string }
// - `date` is the day the feature actually shipped (commit date), not today.
// - Keep newest date first; within a date, most user-visible entry first.
// - To add a new entry later: prepend a new date group (or a new entry
//   within today's group) at the top of the array below.
"use strict";

const CHANGELOG = [
  {
    date: "2026-07-15",
    title: "Parallel multi-agent subtasks",
    description: "The agent can now investigate multiple independent things at once, with live per-task progress shown right in the chat.",
  },
  {
    date: "2026-07-15",
    title: "Files-changed undo bar",
    description: "Agent edits now show a \"Files changed\" card you can click to jump straight to the diff in the editor.",
  },
  {
    date: "2026-07-15",
    title: "Per-file undo",
    description: "Each file in the Files-changed card now has its own Undo button, so you can revert one file without undoing the whole turn.",
  },
  {
    date: "2026-07-15",
    title: "Chat panel polish",
    description: "Fixed the composer overflowing near the Send button, swapped the last emoji icons for SVGs, and evened out spacing on the empty-state screen.",
  },
  {
    date: "2026-07-15",
    title: "Fixed history button clipping",
    description: "The chat history button no longer gets clipped off the edge of the panel at narrow widths.",
  },
  {
    date: "2026-07-15",
    title: "Fixed mobile composer on Remote Access",
    description: "The Remote Access composer on phones no longer gets hidden behind the on-screen keyboard.",
  },
  {
    date: "2026-07-15",
    title: "Optional reliability tracing",
    description: "Added opt-in tracing for the agent's own runs — off by default, and only ever sent to a self-hosted endpoint you configure, never a default remote service.",
  },
  {
    date: "2026-07-14",
    title: "Remote Access: control your agent from your phone",
    description: "Pair your phone via QR code to view and control your LakshX session remotely, including switching modes.",
  },
  {
    date: "2026-07-14",
    title: "Composer file attachments",
    description: "Drag files onto the composer, type @ to fuzzy-search and mention a workspace file, or attach the file you're currently editing.",
  },
];

module.exports = { CHANGELOG };
