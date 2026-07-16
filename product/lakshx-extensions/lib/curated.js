"use strict";

// Curated, hand-maintained list of extensions LakshX is willing to recommend
// through the "Recommended & Verified" panel (see ../extension.js).
//
// WHY THIS FILE EXISTS
// ---------------------
// LakshX's extensionsGallery.serviceUrl points at open-vsx.org, not the
// Microsoft Marketplace (see product/product.overrides.json and
// docs/architecture.md). A VS Code fork that recommends `publisher.name`
// extension IDs which were only ever published to the Microsoft Marketplace
// creates a namespace-squatting opportunity: an attacker registers that same
// `publisher.name` on Open VSX with malicious code, and a user of this fork —
// nudged by a recommendation UI — installs the attacker's package instead of
// the real one. This is a documented, real risk class for VS Code forks (see
// docs/research/15-ide-feature-roadmap.md item #10).
//
// This file is deliberately just data + a validation helper. It does NOT
// talk to the network. The actual trust check — confirming an id really
// resolves on the registry LakshX's gallery points at — lives in
// ./verify.js and is what makes an entry here "verified" rather than merely
// "hand-picked". See README.md's "Verification results" table for the real,
// live results this curated list produced the last time it was checked.
//
// `verifiedOn` is the MAINTAINER'S CLAIM at curation time (informational,
// shown in the panel). It is NOT itself the trust mechanism.
//   - "Open VSX"            confirmed to exist there (spot-checked directly)
//   - "VS Code Marketplace" well-known to exist there; Open VSX unconfirmed
//   - "both"                well-known VS Code Marketplace origin AND
//                            spot-checked / live-verified against Open VSX
//   - "unverified"          added as a candidate only — NOT checked yet.
//                           Must not be shown with a green trust badge, and
//                           must not ship to users, until a maintainer runs
//                           lib/verify.js against it and it resolves.
//
// Every entry below that is NOT marked "unverified" was live-queried against
// the real https://open-vsx.org/api/{namespace}/{name} endpoint as part of
// building this feature (2026-07-17) — see README.md for the raw pass/fail
// record, including a genuine 404 (ms-vscode.cpptools, used only as a test
// fixture in test/verify.test.js, NOT shipped here) that demonstrates
// exactly the squatting risk this panel exists to guard against.

const VERIFIED_ON_VALUES = ["Open VSX", "VS Code Marketplace", "both", "unverified"];

const CATEGORIES = ["Database", "Visualization", "Formatting", "Linting", "Productivity", "Git", "Spelling", "Language Support"];

const CURATED_EXTENSIONS = [
  // --- carried over from product/product.overrides.json's CURRENT
  //     extensionRecommendations (read read-only on 2026-07-17) — these are
  //     LakshX's actual existing recommendations, not invented. That file's
  //     `extensionRecommendations` cleanup is a separate fast-follow; see
  //     README.md. ---
  {
    id: "cweijan.vscode-mysql-client2",
    displayName: "MySQL",
    description: "MySQL / PostgreSQL / SQLite / Redis client — browse schemas and run queries without leaving the editor.",
    category: "Database",
    verifiedOn: "both",
    reason:
      "Already recommended by LakshX today (product.overrides.json onFileOpen for **/*.sql). Live-verified against Open VSX: 200 OK, 1.27M downloads there.",
  },
  {
    id: "LuoZhihao.call-graph",
    displayName: "Call Graph",
    description: "Function call-hierarchy visualization for TS/JS/Python/Go/Java/Rust.",
    category: "Visualization",
    verifiedOn: "both",
    reason:
      "Already recommended by LakshX today (product.overrides.json onFileOpen for common source files). Live-verified against Open VSX: 200 OK.",
  },

  // --- additions: well-known, long-established tools, live-verified below ---
  {
    id: "esbenp.prettier-vscode",
    displayName: "Prettier - Code formatter",
    description: "Opinionated code formatter for JS/TS/CSS/HTML/JSON/Markdown and more.",
    category: "Formatting",
    verifiedOn: "both",
    reason: "One of the most widely used formatters in the ecosystem. Live-verified against Open VSX: 200 OK, 8.25M downloads there.",
  },
  {
    id: "dbaeumer.vscode-eslint",
    displayName: "ESLint",
    description: "Integrates ESLint into VS Code for JavaScript/TypeScript linting.",
    category: "Linting",
    verifiedOn: "both",
    reason: "Canonical ESLint integration. Live-verified against Open VSX: 200 OK, 4.77M downloads there.",
  },
  {
    id: "EditorConfig.EditorConfig",
    displayName: "EditorConfig for VS Code",
    description: "Honors .editorconfig files across the workspace for consistent whitespace/indent settings.",
    category: "Productivity",
    verifiedOn: "both",
    reason: "Small, long-established, low-risk utility. Live-verified against Open VSX: 200 OK, 1.98M downloads there.",
  },
  {
    id: "streetsidesoftware.code-spell-checker",
    displayName: "Code Spell Checker",
    description: "Spell checker that understands camelCase and common code idioms.",
    category: "Spelling",
    verifiedOn: "both",
    reason: "Well-known, actively maintained. Live-verified against Open VSX: 200 OK, 1.47M downloads there.",
  },
  {
    id: "usernamehw.errorlens",
    displayName: "Error Lens",
    description: "Surfaces diagnostics (errors/warnings) inline at the end of the offending line.",
    category: "Productivity",
    verifiedOn: "both",
    reason: "Well-known productivity extension. Live-verified against Open VSX: 200 OK, 932K downloads there.",
  },
  {
    id: "eamodio.gitlens",
    displayName: "GitLens — Git supercharged",
    description: "Git blame annotations, history exploration, and richer Git integration in the editor.",
    category: "Git",
    verifiedOn: "both",
    reason: "One of the most widely installed VS Code extensions. Live-verified against Open VSX: 200 OK, 14.0M downloads there.",
  },
  {
    id: "redhat.vscode-yaml",
    displayName: "YAML",
    description: "YAML language support with schema validation, powered by Red Hat's yaml-language-server.",
    category: "Language Support",
    verifiedOn: "both",
    reason: "Maintained by Red Hat, widely used for k8s/CI YAML authoring. Live-verified against Open VSX: 200 OK, 6.59M downloads there.",
  },
  {
    id: "formulahendry.auto-rename-tag",
    displayName: "Auto Rename Tag",
    description: "Automatically renames the paired HTML/JSX/XML closing tag when you edit the opening one.",
    category: "Productivity",
    verifiedOn: "both",
    reason: "Small, well-known utility. Live-verified against Open VSX: 200 OK, 527K downloads there.",
  },
];

/**
 * Validate the shape of a curated-extension entry. Pure function, no I/O —
 * this is NOT the Open VSX check (that's verify.js); it only checks that the
 * hand-authored data is well-formed enough to render and to hand to verify.js.
 * Returns an array of human-readable problem strings; empty array = valid.
 */
function validateEntry(entry) {
  const problems = [];
  if (!entry || typeof entry !== "object") {
    return ["entry is not an object"];
  }
  const { id, displayName, description, category, verifiedOn, reason } = entry;

  if (typeof id !== "string" || !id) {
    problems.push("id is required and must be a non-empty string");
  } else if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) {
    problems.push(`id "${id}" does not look like "publisher.name"`);
  }

  if (typeof displayName !== "string" || !displayName.trim()) {
    problems.push("displayName is required and must be a non-empty string");
  }

  if (typeof description !== "string" || !description.trim()) {
    problems.push("description is required and must be a non-empty string");
  }

  if (typeof category !== "string" || !CATEGORIES.includes(category)) {
    problems.push(`category "${category}" must be one of: ${CATEGORIES.join(", ")}`);
  }

  if (typeof verifiedOn !== "string" || !VERIFIED_ON_VALUES.includes(verifiedOn)) {
    problems.push(`verifiedOn "${verifiedOn}" must be one of: ${VERIFIED_ON_VALUES.join(", ")}`);
  }

  if (typeof reason !== "string" || !reason.trim()) {
    problems.push("reason is required and must be a non-empty string (why this is trusted)");
  }

  return problems;
}

/**
 * Validate an entire curated list: per-entry shape problems plus list-level
 * invariants (no duplicate ids). Returns { valid: boolean, problems: [{id, problems}] }.
 */
function validateCuratedList(list) {
  const problems = [];
  const seenIds = new Map();

  if (!Array.isArray(list)) {
    return { valid: false, problems: [{ id: null, problems: ["curated list is not an array"] }] };
  }

  list.forEach((entry, index) => {
    const entryProblems = validateEntry(entry);
    const label = entry && entry.id ? entry.id : `#${index}`;
    if (entryProblems.length) {
      problems.push({ id: label, problems: entryProblems });
    }
    if (entry && entry.id) {
      const key = entry.id.toLowerCase();
      if (seenIds.has(key)) {
        problems.push({ id: label, problems: [`duplicate id (also used at index ${seenIds.get(key)})`] });
      } else {
        seenIds.set(key, index);
      }
    }
  });

  return { valid: problems.length === 0, problems };
}

/** Group a (validated) curated list by category, preserving array order within each group. */
function groupByCategory(list) {
  const groups = new Map();
  for (const entry of list) {
    if (!groups.has(entry.category)) groups.set(entry.category, []);
    groups.get(entry.category).push(entry);
  }
  return groups;
}

module.exports = {
  CURATED_EXTENSIONS,
  CATEGORIES,
  VERIFIED_ON_VALUES,
  validateEntry,
  validateCuratedList,
  groupByCategory,
};
