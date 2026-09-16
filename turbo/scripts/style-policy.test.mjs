import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint } from "eslint";

import { checkStylePolicy } from "./style-policy.mjs";

const EMPTY_ALLOWLIST = {
  version: 1,
  selectors: [],
  styleInjections: [],
  classDependencies: [],
  vendorFiles: [],
};

function createWorkspace(testContext, files) {
  const directory = mkdtempSync(join(tmpdir(), "vm0-style-policy-"));
  const root = join(directory, "turbo");
  mkdirSync(root);
  testContext.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: dirname(root),
    encoding: "utf8",
  }).trim();
}

function commitBaseline(root) {
  git(root, "add", "turbo/style-legacy-baseline.json");
  git(
    root,
    "-c",
    "user.name=style-policy-test",
    "-c",
    "user.email=style-policy-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture baseline",
  );
  return git(root, "rev-parse", "HEAD");
}

function createCommandWorkspace(t, files, baseline) {
  const root = createWorkspace(t, files);
  mkdirSync(join(root, "scripts"));
  for (const file of ["style-policy.mjs", "style-class-usage.mjs"]) {
    copyFileSync(join(import.meta.dirname, file), join(root, "scripts", file));
  }
  symlinkSync(
    join(import.meta.dirname, "../node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  writeFileSync(
    join(root, "style-allowlist.json"),
    JSON.stringify(EMPTY_ALLOWLIST),
  );
  writeFileSync(
    join(root, "style-legacy-baseline.json"),
    JSON.stringify(baseline),
  );
  git(root, "init", "--quiet", "--template=");
  commitBaseline(root);
  return root;
}

function runPolicy(root, args = [], ref = "HEAD") {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/style-policy.mjs"), ...args],
    {
      cwd: root,
      env: { ...process.env, STYLE_POLICY_RATCHET_REF: ref },
      encoding: "utf8",
    },
  );
}

function assertRejected(result, diagnostic) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, diagnostic);
  assert.match(result.stderr, /Read docs\/styles\.md/);
}

function emptyBaseline(legacyClassTokens = []) {
  return {
    version: 1,
    legacyClassTokens,
    cssAtoms: {},
    classUsages: {},
    styleInjections: {},
  };
}

test("freezes existing selector declarations and class dependencies", (t) => {
  const root = createWorkspace(t, {
    "apps/platform/src/example.css": ".legacy { color: red }",
    "apps/platform/src/view.tsx":
      'export const View = () => <div className="legacy" />;',
  });
  const baseline = {
    ...emptyBaseline(["legacy"]),
    cssAtoms: {
      "apps/platform/src/example.css": [
        {
          atRules: [],
          selector: ".legacy",
          property: "color",
          value: "red",
          important: false,
        },
      ],
    },
    classUsages: {
      "apps/platform/src/view.tsx": { legacy: 1 },
    },
  };
  assert.deepEqual(
    checkStylePolicy({ root, allowlist: EMPTY_ALLOWLIST, baseline }).issues,
    [],
  );

  writeFileSync(
    join(root, "apps/platform/src/example.css"),
    ".legacy { color: blue }",
  );
  writeFileSync(
    join(root, "apps/platform/src/view.tsx"),
    'export const View = () => <><div className="legacy" /><div className="legacy" /></>;',
  );
  const result = checkStylePolicy({
    root,
    allowlist: EMPTY_ALLOWLIST,
    baseline,
  });

  assert.equal(
    result.issues.some(({ message }) => {
      return message.includes("Legacy class `legacy` usage grew from 1 to 2");
    }),
    true,
  );
  assert.equal(
    result.issues.some(({ type }) => type === "growth"),
    true,
  );
  assert.equal(
    result.issues.some(({ type }) => type === "stale"),
    true,
  );
});

test("an exact third-party selector allowlist does not authorize siblings", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createWorkspace(t, { [file]: ".adapter { color: blue }" });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    selectors: [
      {
        file,
        atRules: [],
        selector: ".adapter",
        kind: "third-party-dom-adapter",
        owner: "frontend-infra",
        rationale: "The upstream widget owns this DOM class.",
        upstream: "example-widget",
        removal: "Remove with the widget.",
      },
    ],
  };
  const baseline = emptyBaseline();
  assert.deepEqual(checkStylePolicy({ root, allowlist, baseline }).issues, []);

  writeFileSync(join(root, file), ".adapter, .sibling { color: blue }");
  const result = checkStylePolicy({ root, allowlist, baseline });
  assert.equal(
    result.issues.some(({ type }) => type === "growth"),
    true,
  );
  assert.equal(
    result.issues.some(({ type }) => type === "allowlist"),
    true,
  );
});

test("counts literal legacy classes without matching longer class names", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createWorkspace(t, {
    [file]: [
      'export const View = () => <div className="legacy legacy-extra xlegacy legacy_x motion-safe:legacy [&_.legacy]:block custom[part]+token customparttoken" />;',
      'document.querySelectorAll(".legacy + .legacy-extra + .legacy");',
    ].join("\n"),
  });
  const baseline = {
    ...emptyBaseline(["legacy", "custom[part]+token"]),
    classUsages: {
      [file]: { legacy: 5, "custom[part]+token": 1 },
    },
  };

  assert.deepEqual(
    checkStylePolicy({ root, allowlist: EMPTY_ALLOWLIST, baseline }).issues,
    [],
  );
});

test("an allowlisted class dependency authorizes one file, not the class", (t) => {
  const owned = "apps/platform/src/frame.tsx";
  const other = "apps/platform/src/other.tsx";
  const root = createWorkspace(t, {
    [owned]: 'export const Frame = () => <div className="adapter" />;',
    [other]: 'export const Other = () => <div className="adapter" />;',
  });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    classDependencies: [
      {
        file: owned,
        token: "adapter",
        count: 1,
        kind: "third-party-dom-adapter",
        owner: "frontend-platform",
        rationale: "The renderer keys on this class.",
        upstream: "example renderer DOM",
        removal: "Remove when the renderer is replaced.",
      },
    ],
  };

  const issues = checkStylePolicy({
    root,
    allowlist,
    baseline: emptyBaseline(),
  }).issues;

  assert.deepEqual(
    issues.map((issue) => {
      return { file: issue.file, type: issue.type };
    }),
    [{ file: other, type: "growth" }],
  );
  assert.match(issues[0].message, /Replace the new use with Tailwind/u);
});

test("an allowlisted class dependency rejects a higher count in its own file", (t) => {
  const owned = "apps/platform/src/frame.tsx";
  const root = createWorkspace(t, {
    [owned]: [
      'export const Frame = () => <div className="adapter" />;',
      'export const Second = () => <span className="adapter" />;',
    ].join("\n"),
  });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    classDependencies: [
      {
        file: owned,
        token: "adapter",
        count: 1,
        kind: "third-party-dom-adapter",
        owner: "frontend-platform",
        rationale: "The renderer keys on this class.",
        upstream: "example renderer DOM",
        removal: "Remove when the renderer is replaced.",
      },
    ],
  };

  const issues = checkStylePolicy({
    root,
    allowlist,
    baseline: emptyBaseline(),
  }).issues;

  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "growth");
  assert.match(issues[0].message, /not a license to spread the class/u);
});

test("an allowlisted class dependency reports a count that no longer matches", (t) => {
  const owned = "apps/platform/src/frame.tsx";
  const root = createWorkspace(t, {
    [owned]: "export const Frame = () => <div />;",
  });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    classDependencies: [
      {
        file: owned,
        token: "adapter",
        count: 1,
        kind: "third-party-dom-adapter",
        owner: "frontend-platform",
        rationale: "The renderer keys on this class.",
        upstream: "example renderer DOM",
        removal: "Remove when the renderer is replaced.",
      },
    ],
  };

  const issues = checkStylePolicy({
    root,
    allowlist,
    baseline: emptyBaseline(),
  }).issues;

  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "stale");
  assert.match(issues[0].message, /style-allowlist\.json/u);
});

test("rejects a new inline stylesheet", (t) => {
  const jsxFile = "packages/ui/src/view.tsx";
  const htmlFile = "apps/platform/src/html.ts";
  const templateFile = "apps/platform/src/template.ts";
  const root = createWorkspace(t, {
    [jsxFile]: 'export const View = () => <style>{".new-class {}"}</style>;',
    [htmlFile]:
      'export const html = "<style>.new-class { color: red }</style>";',
    [templateFile]: "export const html = `<style>${dynamicCss}</style>`;",
  });
  const result = checkStylePolicy({
    root,
    allowlist: EMPTY_ALLOWLIST,
    baseline: emptyBaseline(),
  });

  assert.deepEqual(
    result.issues
      .filter(({ message }) => {
        return message.includes(
          "New inline or injected stylesheet is forbidden",
        );
      })
      .map(({ file }) => file)
      .sort(),
    [htmlFile, jsxFile, templateFile].sort(),
  );
});

test("pins vendored CSS by exact hash", (t) => {
  const file =
    "apps/platform/src/views/css/vendor/uiw-react-markdown-preview-5.2.0.css";
  const original = ".upstream { color: red }";
  const root = createWorkspace(t, { [file]: original });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    vendorFiles: [
      {
        file,
        sha256: createHash("sha256").update(original).digest("hex"),
        owner: "frontend-platform",
        upstream: "example upstream 1.0.0",
        rationale: "This fixture represents an immutable upstream artifact.",
        removal: "Remove with the fixture upstream.",
      },
    ],
  };
  const baseline = emptyBaseline();
  assert.deepEqual(checkStylePolicy({ root, allowlist, baseline }).issues, []);

  writeFileSync(join(root, file), ".upstream { color: blue }");
  assert.equal(
    checkStylePolicy({ root, allowlist, baseline }).issues.some(({ type }) => {
      return type === "vendor";
    }),
    true,
  );
});

test("the Tailwind lint cannot be disabled inline", async () => {
  const eslint = new ESLint({
    allowInlineConfig: false,
    overrideConfigFile: join(import.meta.dirname, "../eslint.style.config.mjs"),
  });
  const [result] = await eslint.lintText(
    '/* eslint-disable better-tailwindcss/no-unknown-classes */ export const View = () => <div className="new-first-party-selector" />;',
    {
      filePath: join(
        import.meta.dirname,
        "../apps/platform/src/style-policy-fixture.tsx",
      ),
    },
  );

  assert.equal(
    result.messages.some(({ ruleId }) => {
      return ruleId === "better-tailwindcss/no-unknown-classes";
    }),
    true,
  );
});

function selectorBaseline(property = "color", value = "red") {
  return {
    ...emptyBaseline(["legacy"]),
    cssAtoms: {
      "apps/platform/src/example.css": [
        {
          atRules: [],
          selector: ".legacy",
          property,
          value,
          important: false,
        },
      ],
    },
  };
}

test("the command rejects nested declarations and apply under a frozen class", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createCommandWorkspace(
    t,
    { [file]: ".legacy { color: red }" },
    selectorBaseline(),
  );
  assert.equal(runPolicy(root).status, 0);
  for (const addition of [
    "&:hover { color: blue }",
    "span { color: blue }",
    "@media (hover: hover) { color: blue }",
    "@media (hover: hover) { &:hover { color: blue } }",
    "@apply bg-red-500;",
  ]) {
    writeFileSync(join(root, file), `.legacy { color: red; ${addition} }`);
    assertRejected(
      runPolicy(root),
      /New first-party CSS class selector declaration/,
    );
  }
});

test("the command freezes apply contents and the parent of a nested selector", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createCommandWorkspace(
    t,
    { [file]: ".legacy { @apply bg-red-500; }" },
    selectorBaseline("@apply", "bg-red-500"),
  );
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(join(root, file), ".legacy { @apply bg-blue-500; }");
  assertRejected(runPolicy(root), /New first-party CSS/);

  const baseline = selectorBaseline();
  baseline.cssAtoms[file][0].parentSelectors = ["section"];
  writeFileSync(
    join(root, "style-legacy-baseline.json"),
    JSON.stringify(baseline),
  );
  commitBaseline(root);
  writeFileSync(join(root, file), "section { .legacy { color: red } }");
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(join(root, file), "aside { .legacy { color: red } }");
  assertRejected(runPolicy(root), /New first-party CSS/);
});

test("the command rejects class-qualified scope roots and limits", (t) => {
  const file = "apps/platform/src/example.css";
  const original = ".legacy { color: red }";
  const root = createCommandWorkspace(
    t,
    { [file]: original },
    selectorBaseline(),
  );
  assert.equal(runPolicy(root).status, 0);
  for (const addition of [
    "@scope (.legacy) { :scope { color: blue } }",
    "@scope (.legacy) { &:hover { color: blue } }",
    "@scope (.legacy) { span { color: blue } }",
    "@scope (.legacy) { @media (hover: hover) { span { color: blue } } }",
    "@scope (main) to (.legacy) { span { color: blue } }",
    "@scope (.legacy) { @scope (section) { span { color: blue } } }",
    "@scope (.legacy) { @scope { span { color: blue } } }",
    "@SCOPE (.legacy) { span { color: blue } }",
  ]) {
    writeFileSync(join(root, file), `${original}\n${addition}`);
    assertRejected(runPolicy(root), /New first-party CSS/);
    assertRejected(runPolicy(root, ["--prune"]), /New first-party CSS/);
  }
});

test("the command freezes scope boundaries and scoped declarations", (t) => {
  const file = "apps/platform/src/example.css";
  const scope = "@scope (.legacy) to (.boundary)";
  const original = `${scope} { span { color: red } }`;
  const baseline = {
    ...emptyBaseline(["legacy"]),
    cssAtoms: {
      [file]: [
        {
          atRules: [scope],
          parentSelectors: [scope],
          selector: "span",
          property: "color",
          value: "red",
          important: false,
        },
      ],
    },
  };
  const root = createCommandWorkspace(t, { [file]: original }, baseline);
  assert.equal(runPolicy(root).status, 0);
  for (const changed of [
    original.replace(".legacy", ".other"),
    original.replace(".boundary", ".other"),
    original.replace("span", "button"),
    original.replace("red", "blue"),
    `${scope} { @scope (section) { span { color: red } } }`,
  ]) {
    writeFileSync(join(root, file), changed);
    assertRejected(runPolicy(root), /New first-party CSS/);
  }
  writeFileSync(join(root, file), "");
  assert.equal(runPolicy(root, ["--prune"]).status, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "style-legacy-baseline.json"), "utf8")),
    emptyBaseline(),
  );
});

test("the command matches scope adapters exactly without leaking context to siblings", (t) => {
  const file = "apps/platform/src/example.css";
  const scope = "@scope (.adapter) to (.boundary)";
  const original = `${scope} { span { color: red } }`;
  const root = createCommandWorkspace(t, { [file]: original }, emptyBaseline());
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    selectors: [
      {
        file,
        atRules: [scope],
        parentSelectors: [scope],
        selector: "span",
        kind: "third-party-dom-adapter",
        owner: "frontend-infra",
        upstream: "example-widget",
        rationale: "The widget owns the scoped root and boundary classes.",
        removal: "Remove with the widget.",
      },
    ],
  };
  writeFileSync(join(root, "style-allowlist.json"), JSON.stringify(allowlist));
  writeFileSync(
    join(root, file),
    `${original} @scope { span { margin: 0 } } button { margin: 0 }`,
  );
  assert.equal(runPolicy(root).status, 0);
  for (const changed of [
    original.replace(".adapter", ".other"),
    original.replace(".boundary", ".other"),
    `${scope} { span { color: red } button { color: blue } }`,
    `${scope} { @scope (section) { span { color: red } } }`,
  ]) {
    writeFileSync(join(root, file), changed);
    assertRejected(runPolicy(root), /New first-party CSS/);
  }
});

test("dialog content styling remains subject to the legacy class ratchet", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(
    t,
    {
      [file]:
        'export const View = () => <DialogContent contentClassName="flex" />;',
    },
    emptyBaseline(["legacy"]),
  );
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(
    join(root, file),
    'const CONTENT = "legacy"; export const View = () => <DialogContent contentClassName={CONTENT} />;',
  );
  assertRejected(runPolicy(root), /usage grew from 0 to 1/);
});

test("the command counts local and re-exported class aliases at each consumer", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(
    t,
    {
      "apps/platform/src/classes.ts": 'export const CARD = "legacy";',
      "apps/platform/src/index.ts": 'export { CARD as ROOT } from "./classes";',
      [file]:
        'const CARD = "legacy"; export const View = () => <div className={CARD}/>;',
    },
    {
      ...emptyBaseline(["legacy"]),
      classUsages: { [file]: { legacy: 1 } },
    },
  );
  const declarations = [
    'const CARD = "legacy";',
    'import { ROOT as CARD } from "./index";',
    'import * as styles from "./index"; const CARD = styles.ROOT;',
    'const styles = { root: "legacy" }; const CARD = styles.root;',
    'const styles = { root: "legacy" }; const CARD = styles["root"];',
    'const styles = { root: "legacy" }; const { root: CARD } = styles;',
    'const styles = ["legacy"] as const; const [CARD] = styles;',
  ];
  for (const declaration of declarations) {
    writeFileSync(
      join(root, file),
      `${declaration} export const View = () => <div className={CARD}/>;`,
    );
    const accepted = runPolicy(root);
    assert.equal(accepted.status, 0, `${declaration}\n${accepted.stderr}`);
    writeFileSync(
      join(root, file),
      `${declaration} export const View = () => <><div className={CARD}/><div className={CARD}/></>;`,
    );
    assertRejected(runPolicy(root), /usage grew from 1 to 2/);
  }
  writeFileSync(
    join(root, "apps/platform/src/extra.tsx"),
    'import { ROOT } from "./index"; export const Extra = () => <div className={ROOT}/>;',
  );
  assertRejected(runPolicy(root), /usage grew from 0 to 1/);
});

test("class resolution respects lexical scopes, repeated expressions, and cycles", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(
    t,
    {
      [file]:
        'const CARD = "legacy"; function View() { const CARD = "flex"; return <div className={CARD}/>; }',
    },
    emptyBaseline(["legacy"]),
  );
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(
    join(root, file),
    'const CARD = "legacy"; export const View = () => <div className={cn(CARD, CARD)}/>;',
  );
  assertRejected(runPolicy(root), /usage grew from 0 to 2/);
  for (const expression of [
    "cn({ legacy: enabled })",
    "cn({ [CARD]: enabled })",
    "cn({ legacy })",
    'cn({ state: "legacy" })',
  ]) {
    writeFileSync(
      join(root, file),
      `const CARD = "legacy"; export const View = () => <div className={${expression}}/>;`,
    );
    assertRejected(runPolicy(root), /usage grew from 0 to 1/);
  }
  writeFileSync(
    join(root, file),
    'const A = B; const B = A; export const View = () => <div className={cn(A, "legacy")}/>;',
  );
  assertRejected(runPolicy(root), /usage grew from 0 to 1/);
});

test("pruning persists only removals and refuses source growth", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createCommandWorkspace(
    t,
    { [file]: ".legacy { color: red }" },
    selectorBaseline(),
  );
  writeFileSync(join(root, file), "");
  assertRejected(runPolicy(root), /baseline down/);
  const pruned = runPolicy(root, ["--prune"]);
  assert.equal(pruned.status, 0, pruned.stderr);
  const baselineFile = join(root, "style-legacy-baseline.json");
  assert.deepEqual(
    JSON.parse(readFileSync(baselineFile, "utf8")),
    emptyBaseline(),
  );
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(join(root, file), ".new-class { color: blue }");
  assertRejected(runPolicy(root, ["--prune"]), /New first-party CSS/);
  assert.deepEqual(
    JSON.parse(readFileSync(baselineFile, "utf8")),
    emptyBaseline(),
  );
});

test("the command rejects baseline growth against the selected Git reference", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(t, { [file]: "" }, emptyBaseline());
  const base = git(root, "rev-parse", "HEAD");
  const grown = {
    ...emptyBaseline(["legacy"]),
    classUsages: { [file]: { legacy: 1 } },
  };
  writeFileSync(
    join(root, "style-legacy-baseline.json"),
    JSON.stringify(grown),
  );
  writeFileSync(
    join(root, file),
    'export const View = () => <div className="legacy"/>;',
  );
  assertRejected(runPolicy(root), /Shrink-only baseline/);
  assertRejected(runPolicy(root, ["--prune"]), /Shrink-only baseline/);
  commitBaseline(root);
  assert.equal(runPolicy(root).status, 0);
  assertRejected(runPolicy(root, [], base), /Shrink-only baseline/);
});

test("the command fails visibly for malformed existing baselines and invalid Git refs", (t) => {
  const root = createCommandWorkspace(t, {}, emptyBaseline());
  const baselineFile = join(root, "style-legacy-baseline.json");
  writeFileSync(baselineFile, "{ invalid json }");
  commitBaseline(root);
  writeFileSync(baselineFile, JSON.stringify(emptyBaseline()));
  assertRejected(runPolicy(root), /style-policy\/configuration/);
  assertRejected(
    runPolicy(root, [], "nonexistent-style-policy-ref"),
    /style-policy\/configuration/,
  );
  writeFileSync(baselineFile, "{ invalid json }");
  assertRejected(runPolicy(root), /style-policy\/configuration/);
});

test("only a genuinely absent reference baseline permits initial introduction", (t) => {
  const root = createCommandWorkspace(t, {}, emptyBaseline());
  git(root, "rm", "--cached", "turbo/style-legacy-baseline.json");
  git(
    root,
    "-c",
    "user.name=style-policy-test",
    "-c",
    "user.email=style-policy-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture without baseline",
  );
  const result = runPolicy(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Style policy passed/);
});

test("invalid baseline counters and empty tokens fail instead of weakening the ratchet", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(t, { [file]: "" }, emptyBaseline());
  const baselineFile = join(root, "style-legacy-baseline.json");
  for (const count of ["not-a-number", null, -1, 1.5]) {
    const malformed = {
      ...emptyBaseline(["legacy"]),
      classUsages: { [file]: { legacy: count } },
    };
    writeFileSync(baselineFile, JSON.stringify(malformed));
    assertRejected(runPolicy(root), /positive integer counts/);
  }
  commitBaseline(root);
  writeFileSync(baselineFile, JSON.stringify(emptyBaseline()));
  assertRejected(runPolicy(root), /positive integer counts/);
  writeFileSync(baselineFile, JSON.stringify(emptyBaseline([""])));
  assertRejected(runPolicy(root), /non-empty strings/);
});
