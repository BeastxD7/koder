"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  languageOf,
  extractImports,
  resolveImport,
  buildGraph,
  detectCycles,
} = require("../lib/depgraph.js");

// ---------------------------------------------------------------------------
// languageOf
// ---------------------------------------------------------------------------
test("languageOf maps extensions to a language bucket", () => {
  assert.equal(languageOf("src/a.ts"), "js");
  assert.equal(languageOf("src/a.tsx"), "js");
  assert.equal(languageOf("src/a.jsx"), "js");
  assert.equal(languageOf("src/a.mjs"), "js");
  assert.equal(languageOf("src/a.py"), "py");
  assert.equal(languageOf("README.md"), null);
  assert.equal(languageOf("noext"), null);
});

// ---------------------------------------------------------------------------
// JS/TS extraction
// ---------------------------------------------------------------------------
test("extractImports: JS static, default, named, side-effect, export-from", () => {
  const src = `
    import foo from "./foo";
    import { a, b } from "./bar";
    import "./sideeffect.css";
    export { x } from "./reexport";
    export * from "./star";
  `;
  const specs = extractImports(src, "js").map((i) => i.spec);
  assert.ok(specs.includes("./foo"));
  assert.ok(specs.includes("./bar"));
  assert.ok(specs.includes("./sideeffect.css"));
  assert.ok(specs.includes("./reexport"));
  assert.ok(specs.includes("./star"));
});

test("extractImports: JS multi-line named import list", () => {
  const src = `import {
    thingOne,
    thingTwo,
    thingThree
  } from "../lib/things";`;
  const specs = extractImports(src, "js").map((i) => i.spec);
  assert.deepEqual(specs, ["../lib/things"]);
});

test("extractImports: JS dynamic import() and require()", () => {
  const src = `
    const m = await import("./lazy");
    const cjs = require("./legacy");
    const pkg = require("lodash");
  `;
  const imps = extractImports(src, "js");
  const byKind = Object.fromEntries(imps.map((i) => [i.spec, i.kind]));
  assert.equal(byKind["./lazy"], "dynamic");
  assert.equal(byKind["./legacy"], "require");
  assert.equal(byKind["lodash"], "require");
});

test("extractImports: JS template-literal dynamic import with ${} is skipped, not crashed", () => {
  const src = "const m = await import(`./plugins/${name}`);\nimport ok from './ok';";
  const specs = extractImports(src, "js").map((i) => i.spec);
  assert.ok(!specs.some((s) => s.includes("$")));
  assert.ok(specs.includes("./ok"));
});

test("extractImports: JS ignores imports inside block comments", () => {
  const src = `
    /* import shouldNotAppear from "./ghost"; */
    import real from "./real";
  `;
  const specs = extractImports(src, "js").map((i) => i.spec);
  assert.ok(specs.includes("./real"));
  assert.ok(!specs.includes("./ghost"));
});

test("extractImports: JS dedupes identical (spec, kind) pairs", () => {
  const src = `import a from "./x";\nimport b from "./x";`;
  const specs = extractImports(src, "js").filter((i) => i.spec === "./x");
  assert.equal(specs.length, 1);
});

// ---------------------------------------------------------------------------
// Python extraction
// ---------------------------------------------------------------------------
test("extractImports: Python import / from / relative / dotted", () => {
  const src = [
    "import os",
    "import a.b.c as d",
    "import x, y.z",
    "from . import sibling",
    "from .mod import thing",
    "from ..pkg.sub import other",
    "from package.deep import q  # trailing comment",
  ].join("\n");
  const specs = extractImports(src, "py").map((i) => i.spec);
  assert.ok(specs.includes("os"));
  assert.ok(specs.includes("a.b.c"));
  assert.ok(specs.includes("x"));
  assert.ok(specs.includes("y.z"));
  assert.ok(specs.includes("."));
  assert.ok(specs.includes(".mod"));
  assert.ok(specs.includes("..pkg.sub"));
  assert.ok(specs.includes("package.deep"));
});

test("extractImports: Python ignores # comments", () => {
  const src = "# import ghost\nimport real";
  const specs = extractImports(src, "py").map((i) => i.spec);
  assert.deepEqual(specs, ["real"]);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
test("resolveImport: JS relative resolves with extension try-order (ts before js)", () => {
  const fileSet = new Set(["src/foo.ts", "src/foo.js", "src/app.ts"]);
  const res = resolveImport("src/app.ts", { spec: "./foo", kind: "import" }, fileSet, "js");
  assert.deepEqual(res, { type: "internal", target: "src/foo.ts" });
});

test("resolveImport: JS relative resolves to index file", () => {
  const fileSet = new Set(["src/widget/index.tsx", "src/app.ts"]);
  const res = resolveImport("src/app.ts", { spec: "./widget", kind: "import" }, fileSet, "js");
  assert.deepEqual(res, { type: "internal", target: "src/widget/index.tsx" });
});

test("resolveImport: JS parent-relative path", () => {
  const fileSet = new Set(["lib/util.js", "src/deep/app.js"]);
  const res = resolveImport("src/deep/app.js", { spec: "../../lib/util", kind: "import" }, fileSet, "js");
  assert.deepEqual(res, { type: "internal", target: "lib/util.js" });
});

test("resolveImport: JS bare import → external, package name grouped", () => {
  const fileSet = new Set(["src/app.ts"]);
  assert.deepEqual(
    resolveImport("src/app.ts", { spec: "react", kind: "import" }, fileSet, "js"),
    { type: "external", name: "react" },
  );
  assert.deepEqual(
    resolveImport("src/app.ts", { spec: "react-dom/client", kind: "import" }, fileSet, "js"),
    { type: "external", name: "react-dom" },
  );
  assert.deepEqual(
    resolveImport("src/app.ts", { spec: "@scope/pkg/sub", kind: "import" }, fileSet, "js"),
    { type: "external", name: "@scope/pkg" },
  );
});

test("resolveImport: Python relative resolves to module and package __init__", () => {
  const fileSet = new Set(["pkg/app.py", "pkg/mod.py", "pkg/sub/__init__.py"]);
  assert.deepEqual(
    resolveImport("pkg/app.py", { spec: ".mod", kind: "from" }, fileSet, "py"),
    { type: "internal", target: "pkg/mod.py" },
  );
  assert.deepEqual(
    resolveImport("pkg/app.py", { spec: ".sub", kind: "from" }, fileSet, "py"),
    { type: "internal", target: "pkg/sub/__init__.py" },
  );
});

test("resolveImport: Python parent-relative (two dots) climbs a package level", () => {
  const fileSet = new Set(["pkg/a/app.py", "pkg/shared.py"]);
  assert.deepEqual(
    resolveImport("pkg/a/app.py", { spec: "..shared", kind: "from" }, fileSet, "py"),
    { type: "internal", target: "pkg/shared.py" },
  );
});

test("resolveImport: Python stdlib/absolute unknown → external", () => {
  const fileSet = new Set(["pkg/app.py"]);
  assert.deepEqual(
    resolveImport("pkg/app.py", { spec: "os", kind: "import" }, fileSet, "py"),
    { type: "external", name: "os" },
  );
});

// ---------------------------------------------------------------------------
// buildGraph + metrics
// ---------------------------------------------------------------------------
test("buildGraph: nodes, edges, fan-in/out, external grouping, orphans", () => {
  const files = [
    { path: "src/a.ts", text: `import { b } from "./b"; import react from "react";` },
    { path: "src/b.ts", text: `import { c } from "./c";` },
    { path: "src/c.ts", text: `import react from "react";` },
    { path: "src/orphan.ts", text: `const x = 1;` },
  ];
  const g = buildGraph(files);
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));

  assert.equal(byId["src/a.ts"].fanOut, 2); // ./b + react
  assert.equal(byId["src/b.ts"].fanIn, 1); // from a
  assert.equal(byId["src/b.ts"].fanOut, 1); // ./c
  assert.equal(byId["ext:react"].type, "external");
  assert.equal(byId["ext:react"].fanIn, 2); // a and c both import react

  assert.equal(g.stats.internalNodes, 4);
  assert.equal(g.stats.externalNodes, 1);
  assert.equal(g.stats.orphanCount, 1); // orphan.ts
  assert.equal(byId["src/orphan.ts"].fanIn, 0);
  assert.equal(byId["src/orphan.ts"].fanOut, 0);
});

test("buildGraph: includeExternal:false drops package nodes", () => {
  const files = [{ path: "src/a.ts", text: `import react from "react"; import { b } from "./b";` }, { path: "src/b.ts", text: "" }];
  const g = buildGraph(files, { includeExternal: false });
  assert.ok(!g.nodes.some((n) => n.type === "external"));
  assert.equal(g.stats.externalNodes, 0);
});

test("buildGraph: self-import is ignored", () => {
  const files = [{ path: "src/a.ts", text: `import x from "./a";` }];
  const g = buildGraph(files);
  assert.equal(g.edges.length, 0);
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------
test("detectCycles: finds a simple 2-cycle A<->B", () => {
  const files = [
    { path: "a.ts", text: `import "./b";` },
    { path: "b.ts", text: `import "./a";` },
  ];
  const g = buildGraph(files);
  assert.equal(g.cycles.length, 1);
  assert.deepEqual(new Set(g.cycles[0]), new Set(["a.ts", "b.ts"]));
  assert.equal(g.nodes.find((n) => n.id === "a.ts").inCycle, true);
  assert.equal(g.stats.cycleCount, 1);
});

test("detectCycles: finds a 3-cycle A->B->C->A", () => {
  const files = [
    { path: "a.ts", text: `import "./b";` },
    { path: "b.ts", text: `import "./c";` },
    { path: "c.ts", text: `import "./a";` },
  ];
  const g = buildGraph(files);
  assert.equal(g.cycles.length, 1);
  assert.deepEqual(new Set(g.cycles[0]), new Set(["a.ts", "b.ts", "c.ts"]));
});

test("detectCycles: a pure DAG reports no cycles", () => {
  const files = [
    { path: "a.ts", text: `import "./b"; import "./c";` },
    { path: "b.ts", text: `import "./c";` },
    { path: "c.ts", text: `` },
  ];
  const g = buildGraph(files);
  assert.equal(g.cycles.length, 0);
  assert.ok(g.nodes.every((n) => !n.inCycle));
});

test("detectCycles: external nodes never participate in a cycle", () => {
  // react is a shared sink; must not create a false cycle
  const files = [
    { path: "a.ts", text: `import "react"; import "./b";` },
    { path: "b.ts", text: `import "react";` },
  ];
  const g = buildGraph(files);
  assert.equal(g.cycles.length, 0);
});

test("detectCycles: directly on nodes+edges detects self-loop", () => {
  const nodes = [{ id: "x", type: "internal" }];
  const edges = [{ from: "x", to: "x" }];
  const cycles = detectCycles(nodes, edges);
  assert.deepEqual(cycles, [["x"]]);
});

test("buildGraph: is robust on a larger synthetic graph without throwing", () => {
  const files = [];
  for (let i = 0; i < 300; i++) {
    files.push({ path: `m${i}.ts`, text: `import "./m${(i + 1) % 300}";` }); // one big 300-cycle
  }
  const g = buildGraph(files);
  assert.equal(g.stats.internalNodes, 300);
  assert.equal(g.cycles.length, 1);
  assert.equal(g.cycles[0].length, 300);
});
