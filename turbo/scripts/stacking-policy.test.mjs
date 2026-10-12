import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const FILE = "apps/platform/src/layer.tsx";
const emptyStylePolicy = {
  version: 1,
  selectors: [],
  styleInjections: [],
  classDependencies: [],
  vendorFiles: [],
};

function entry(overrides = {}) {
  return {
    file: FILE,
    scope: "Card",
    kind: "utility",
    value: "z-10",
    count: 1,
    owner: "Card loading cover",
    host: "Card isolated thumbnail wrapper",
    rationale: "Keep the loading cover above its image, below card controls.",
    status: "verified",
    evidence: "https://github.com/okou-ai/okou/issues/35878",
    ...overrides,
  };
}

function workspace(t, files, entries = []) {
  const root = mkdtempSync(join(tmpdir(), "okou-stacking-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contents = {
    "style-allowlist.json": JSON.stringify(emptyStylePolicy),
    "stacking-ownership.json": JSON.stringify({ version: 1, entries }),
    ...files,
  };
  for (const [file, text] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function run(root) {
  return spawnSync(
    process.execPath,
    [join(import.meta.dirname, "style-policy.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function rejected(root, diagnostic = /style-policy\/stacking-ownership/) {
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, diagnostic);
  assert.match(result.stderr, /Read docs\/app\/styles\.md/);
  return result.stderr;
}

test("the real style CLI requires exact ownership for every utility spelling", (t) => {
  const utilities = [
    "z-0",
    "z-auto",
    "-z-10",
    "before:-z-1",
    "z-[2147483647]",
    "z-(--layer)",
    "z-[var(--layer)]",
    "hover:focus-visible:!z-10",
    "data-[state=open]:z-20!",
    "[&>div]:-z-[2]",
    "[z-index:30]",
    "hover:[z-index:var(--layer)]",
  ];
  const root = workspace(t, {
    [FILE]: `function Card() { return <div className="${utilities.join(" ")}" />; }`,
  });
  const stderr = rejected(root);
  for (const token of utilities)
    assert.ok(stderr.includes(`\`${token}\``), stderr);
});

test("complete literals in constants, cva, class maps and template branches are declarations", (t) => {
  const root = workspace(t, {
    [FILE]:
      'const layer = "z-10"; const variants = cva("", { variants: { active: { true: "focus:z-20" } } }); function Card() { return <div className={cn(layer, { "-z-1": active }, `flex ${active ? "z-30" : "z-40"}`)} />; }',
  });
  const stderr = rejected(root);
  for (const value of ["z-10", "focus:z-20", "-z-1", "z-30", "z-40"])
    assert.ok(stderr.includes(`\`${value}\``));
});

test("inline style objects and native writes cannot bypass utility ownership", (t) => {
  const snippets = [
    "const layer = { zIndex: 4 };",
    'const layer = { "z-index": "var(--layer)" };',
    'const layer = { ["z" + "Index"]: 5 };',
    "const layer = { zIndex };",
    "node.style.zIndex = 6;",
    'node.style["zIndex"] = "7";',
    'Object.assign(node.style, { zIndex: "8" });',
    'node.style.setProperty("z-index", "9", "important");',
  ];
  const root = workspace(t, { [FILE]: snippets.join("\n") });
  assert.equal(
    (rejected(root).match(/style-policy\/stacking-ownership/g) ?? []).length,
    snippets.length,
  );
});

test("TypeScript assertions and CSS apply cannot hide a layer declaration", (t) => {
  const root = workspace(t, {
    "apps/platform/src/layer.ts":
      'const style = <CSSProperties>{ zIndex: 12 }; node.style.setProperty("Z-INDEX", "13");',
    "packages/ui/src/styles/layers.css": ":root { @apply z-10 hover:z-20; }",
  });
  const stderr = rejected(root);
  for (const value of ["12", 'setProperty("13")', "z-10", "hover:z-20"])
    assert.ok(stderr.includes(`\`${value}\``), stderr);
});

test("CSS selectors, nested at-rules, bootstrap HTML and preview documents are covered", (t) => {
  const root = workspace(t, {
    "packages/ui/src/styles/layers.css":
      "/* z-index:999 */ @media (width > 10px) { :root { &::before { Z-INDEX: var(--layer) !important; } } }",
    "apps/platform/index.html":
      '<!-- <div style="z-index:999"> --><style>#bootstrap { z-index:60 }</style><main id="root"><div CLASS="hover:z&#45;10" STYLE=z-index:4></div></main><script>mask.style.zIndex = "8";</script>',
    [FILE]:
      'function preview() { const css = `#editable { z-index: 2 !important; }`; const html = `<div style="z-index:3"></div>`; node.style.cssText = "position:fixed; z-index:5;"; }',
  });
  const stderr = rejected(root);
  for (const value of [
    "var(--layer)!important",
    "60",
    "hover:z-10",
    "4",
    '= "8"',
    "2!important",
    "3",
    "5",
  ]) {
    assert.ok(stderr.includes(`\`${value}\``), stderr);
  }
  assert.ok(stderr.includes("@media (width>10px) > :root > &::before"), stderr);
  assert.ok(stderr.includes("html > body > main#root > div"), stderr);
  assert.ok(!stderr.includes("`999`"), stderr);
});

test("production JS and HTML cannot evade the TSX entry point; fixtures and comments are excluded", (t) => {
  const root = workspace(t, {
    "apps/platform/src/component.jsx": 'const layer = "z-10";',
    "packages/ui/src/layer.js": 'const layer = "z-20";',
    "apps/platform/src/preview.html": '<div class="z-30"></div>',
    "apps/platform/src/component.test.tsx": 'const layer = "z-999";',
    "packages/ui/src/__tests__/fixture.tsx": 'const layer = "z-999";',
    "packages/ui/src/component.stories.tsx": 'const layer = "z-999";',
    [FILE]:
      '// "z-999"\n/* zIndex: 999 */\nconst readOnly = node.style.zIndex; const other = { size: 10 };',
  });
  const stderr = rejected(root);
  for (const token of ["z-10", "z-20", "z-30"])
    assert.ok(stderr.includes(token));
  assert.ok(!stderr.includes("z-999"), stderr);
  assert.equal(
    (stderr.match(/style-policy\/stacking-ownership/g) ?? []).length,
    3,
  );
});

test("dynamic utility and CSS construction is rejected instead of registrable", (t) => {
  const root = workspace(t, {
    [FILE]:
      'const a = `z-${level}`; const b = `hover:z-[${level}]`; const c = "z-" + level; const d = "z-[" + level + "]"; const e = `#preview { z-index: ${level}; }`;',
  });
  const stderr = rejected(root, /style-policy\/stacking-dynamic/);
  assert.ok(
    (stderr.match(/style-policy\/stacking-dynamic/g) ?? []).length >= 5,
  );
});

test("an exact reviewed entry passes, including static classes around unrelated interpolations", (t) => {
  const root = workspace(
    t,
    {
      [FILE]:
        "function Card() { return <div className={`relative z-10 ${color}`} />; }",
    },
    [entry()],
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("reusing a registered constant counts its definition, not its consumers", (t) => {
  const root = workspace(
    t,
    {
      [FILE]:
        'const layer = "z-" + "10"; function Card() { return <><div className={layer}/><div className={layer}/></>; }',
    },
    [entry({ scope: "layer" })],
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("constant template fragments cannot hide a complete layer utility", (t) => {
  const root = workspace(t, {
    [FILE]:
      'const a = `z-${"10"}`; const b = `${"z-"}20`; const c = `hover:z-${30}`;',
  });
  const stderr = rejected(root);
  for (const token of ["z-10", "z-20", "hover:z-30"])
    assert.ok(stderr.includes(`\`${token}\``), stderr);
});

for (const [name, source, diagnostic] of [
  [
    "value change",
    'function Card() { return <div className="z-20" />; }',
    /stacking-ownership/,
  ],
  [
    "variant change",
    'function Card() { return <div className="hover:z-10" />; }',
    /stacking-ownership/,
  ],
  [
    "scope move",
    'function Other() { return <div className="z-10" />; }',
    /stacking-ownership/,
  ],
  [
    "duplicate growth",
    'function Card() { return <><div className="z-10" /><div className="z-10" /></>; }',
    /has 2 declarations/,
  ],
  ["removal", "function Card() { return <div />; }", /stacking-stale/],
]) {
  test(`registry rejects ${name}`, (t) => {
    rejected(workspace(t, { [FILE]: source }, [entry()]), diagnostic);
  });
}

test("moving the same declaration to another file leaves a stale entry and a new violation", (t) => {
  const root = workspace(
    t,
    {
      "packages/ui/src/card.tsx":
        'function Card() { return <div className="z-10" />; }',
    },
    [entry()],
  );
  const stderr = rejected(root);
  assert.match(stderr, /stacking-stale/);
});

test("line-only edits preserve ownership and inline numeric zero still requires registration", (t) => {
  const root = workspace(
    t,
    {
      [FILE]: "\n\nfunction Card() { return <div style={{ zIndex: 0 }} />; }",
    },
    [entry({ kind: "style", value: "0" })],
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("exact CSS scope registration preserves nesting and !important", (t) => {
  const file = "apps/platform/index.html";
  const source = "<style>#bootstrap { z-index:60 !important }</style>";
  const root = workspace(t, { [file]: source }, [
    entry({
      file,
      scope: "html > head > style > #bootstrap",
      kind: "css",
      value: "60!important",
    }),
  ]);
  assert.equal(run(root).status, 0);
  writeFileSync(join(root, file), source.replace("#bootstrap", "#other"));
  assert.match(rejected(root), /stacking-stale/);
});

test("ownership does not authorize handwritten business CSS", (t) => {
  const file = "apps/platform/src/card.css";
  const root = workspace(t, { [file]: ".card { z-index:10 }" }, [
    entry({ file, scope: ".card", kind: "css", value: "10" }),
  ]);
  const stderr = rejected(root, /first-party CSS class selector declaration/);
  assert.ok(!stderr.includes("stacking-ownership"));
});

for (const [name, overrides] of [
  ["wildcard file", { file: "apps/platform/src/*.tsx" }],
  ["traversal", { file: "apps/platform/src/../../outside.tsx" }],
  ["out of scope", { file: "apps/api/src/layer.ts" }],
  ["missing host", { host: "" }],
  ["missing rationale", { rationale: "" }],
  ["missing owner", { owner: "" }],
  ["missing evidence", { evidence: "" }],
  ["unbounded count", { count: -1 }],
  ["fractional count", { count: 1.5 }],
  ["unknown status", { status: "accepted-by-default" }],
]) {
  test(`invalid registry fails closed: ${name}`, (t) => {
    rejected(workspace(t, {}, [entry(overrides)]), /stacking-configuration/);
  });
}

test("missing, malformed, and duplicate registry entries fail closed", (t) => {
  const root = workspace(t, {}, [entry(), entry()]);
  rejected(root, /duplicates an ownership entry/);
  writeFileSync(join(root, "stacking-ownership.json"), "{");
  rejected(root, /stacking-configuration/);
  rmSync(join(root, "stacking-ownership.json"));
  rejected(root, /stacking-configuration/);
});
