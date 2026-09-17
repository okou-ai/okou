import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const OTHER = "apps/platform/src/other.tsx";

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

function createCommandWorkspace(t, files, allowlist = EMPTY_ALLOWLIST) {
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
  writeFileSync(join(root, "style-allowlist.json"), JSON.stringify(allowlist));
  return root;
}

function runPolicy(root, args = []) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/style-policy.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function assertRejected(result, diagnostic) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, diagnostic);
  assert.match(result.stderr, /Read docs\/styles\.md/);
}

// An allowlist that authorizes one class dependency, for the tests that need a
// token the class-usage scanner will look for.
function allowlistWith(file, token, count = 1) {
  return {
    ...EMPTY_ALLOWLIST,
    classDependencies: [
      {
        file,
        token,
        count,
        kind: "third-party-dom-adapter",
        owner: "frontend-platform",
        rationale: "The renderer keys on this class.",
        upstream: "example renderer DOM",
        removal: "Remove when the renderer is replaced.",
      },
    ],
  };
}

test("a selector the allowlist does not name is a violation", (t) => {
  const root = createWorkspace(t, {
    "apps/platform/src/example.css": ".legacy { color: red }",
    "apps/platform/src/view.tsx":
      'export const View = () => <div className="legacy" />;',
  });

  const result = checkStylePolicy({ root, allowlist: EMPTY_ALLOWLIST });

  // The selector is reported. The class is not, because nothing authorizes the
  // token, so the scanner is not looking for it — `no-unknown-classes` is what
  // catches a class the allowlist never names.
  assert.deepEqual(
    result.issues.map((issue) => {
      return issue.type;
    }),
    ["growth"],
  );
  assert.match(result.issues[0].message, /New first-party CSS class selector/u);
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
  assert.deepEqual(checkStylePolicy({ root, allowlist }).issues, []);

  writeFileSync(join(root, file), ".adapter, .sibling { color: blue }");
  const result = checkStylePolicy({ root, allowlist });
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
  const allowlist = {
    ...allowlistWith(file, "legacy", 5),
    classDependencies: [
      ...allowlistWith(file, "legacy", 5).classDependencies,
      ...allowlistWith(file, "custom[part]+token", 1).classDependencies,
    ],
  };

  assert.deepEqual(checkStylePolicy({ root, allowlist }).issues, []);
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
  }).issues;

  assert.deepEqual(
    issues.map((issue) => {
      return { file: issue.file, type: issue.type };
    }),
    [{ file: other, type: "growth" }],
  );
  assert.match(issues[0].message, /allowlisted for another file/u);
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
  assert.deepEqual(checkStylePolicy({ root, allowlist }).issues, []);

  writeFileSync(join(root, file), ".upstream { color: blue }");
  assert.equal(
    checkStylePolicy({ root, allowlist }).issues.some(({ type }) => {
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

// An allowlist that authorizes exactly one selector, optionally inside a scope.
function selectorAllowlist(file, selector, extra = {}) {
  return {
    ...EMPTY_ALLOWLIST,
    selectors: [
      {
        file,
        atRules: [],
        selector,
        kind: "third-party-dom-adapter",
        owner: "frontend-infra",
        rationale: "The upstream widget owns this DOM class.",
        upstream: "example-widget",
        removal: "Remove with the widget.",
        ...extra,
      },
    ],
  };
}

test("an allowlisted selector does not authorize what nests inside it", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createCommandWorkspace(
    t,
    { [file]: ".adapter { color: red }" },
    selectorAllowlist(file, ".adapter"),
  );
  assert.equal(runPolicy(root).status, 0);

  for (const nested of [
    "&:hover { color: blue }",
    "span { color: blue }",
    "@media (hover: hover) { color: blue }",
  ]) {
    writeFileSync(join(root, file), `.adapter { color: red; ${nested} }`);
    assertRejected(runPolicy(root), /New first-party CSS/);
  }

  // The entry authorizes the selector, so its own declarations — `@apply`
  // included — are ordinary reviewed code rather than a second selector.
  writeFileSync(
    join(root, file),
    ".adapter { color: red; @apply bg-red-500; }",
  );
  assert.equal(runPolicy(root).status, 0);
});

test("an allowlisted selector does not authorize a different parent", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createCommandWorkspace(
    t,
    { [file]: ".adapter { color: red }" },
    selectorAllowlist(file, ".adapter"),
  );
  assert.equal(runPolicy(root).status, 0);

  // The same declaration under another parent is a different selector.
  writeFileSync(join(root, file), "section { .adapter { color: red } }");
  assertRejected(runPolicy(root), /New first-party CSS/);
});

test("a class-qualified scope root or limit needs its own entry", (t) => {
  const file = "apps/platform/src/example.css";
  const scope = "@scope (.adapter) to (.boundary)";
  const root = createCommandWorkspace(
    t,
    { [file]: `${scope} { span { color: red } }` },
    selectorAllowlist(file, "span", {
      atRules: [scope],
      parentSelectors: [scope],
    }),
  );
  assert.equal(runPolicy(root).status, 0);

  for (const changed of [
    `@scope (.other) to (.boundary) { span { color: red } }`,
    `@scope (.adapter) to (.other) { span { color: red } }`,
    `${scope} { button { color: red } }`,
  ]) {
    writeFileSync(join(root, file), changed);
    assertRejected(runPolicy(root), /New first-party CSS/);
  }
});
test("the command matches scope adapters exactly without leaking context to siblings", (t) => {
  const file = "apps/platform/src/example.css";
  const scope = "@scope (.adapter) to (.boundary)";
  const original = `${scope} { span { color: red } }`;
  const root = createCommandWorkspace(t, { [file]: original });
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

test("dialog content styling stays subject to the class dependency rule", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(
    t,
    {
      [file]:
        'export const View = () => <DialogContent contentClassName="flex" />;',
      // The entry has to point at a file that really carries the class once,
      // or the policy reports the authorized count as no longer matching.
      [OTHER]: 'export const Other = () => <div className="legacy" />;',
    },
    allowlistWith(OTHER, "legacy"),
  );
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(
    join(root, file),
    'const CONTENT = "legacy"; export const View = () => <DialogContent contentClassName={CONTENT} />;',
  );
  assertRejected(runPolicy(root), /allowlisted for another file/);
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
    allowlistWith(file, "legacy"),
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
  assertRejected(runPolicy(root), /allowlisted for another file/);
});

test("class resolution respects lexical scopes, repeated expressions, and cycles", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(
    t,
    {
      [file]:
        'const CARD = "legacy"; function View() { const CARD = "flex"; return <div className={CARD}/>; }',
      [OTHER]: 'export const Other = () => <div className="legacy" />;',
    },
    allowlistWith(OTHER, "legacy"),
  );
  assert.equal(runPolicy(root).status, 0);
  writeFileSync(
    join(root, file),
    'const CARD = "legacy"; export const View = () => <div className={cn(CARD, CARD)}/>;',
  );
  assertRejected(runPolicy(root), /allowlisted for another file/);
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
    assertRejected(runPolicy(root), /allowlisted for another file/);
  }
  writeFileSync(
    join(root, file),
    'const A = B; const B = A; export const View = () => <div className={cn(A, "legacy")}/>;',
  );
  assertRejected(runPolicy(root), /allowlisted for another file/);
});

test("a malformed or invalid allowlist fails visibly instead of passing", (t) => {
  const file = "apps/platform/src/view.tsx";
  const root = createCommandWorkspace(
    t,
    { [file]: 'export const View = () => <div className="adapter" />;' },
    allowlistWith(file, "adapter"),
  );
  assert.equal(runPolicy(root).status, 0);
  const entry = allowlistWith(file, "adapter").classDependencies[0];

  function writeAllowlist(contents) {
    writeFileSync(join(root, "style-allowlist.json"), contents);
  }

  // Unparseable JSON never reaches a policy rule, so the command has to stop
  // rather than report a clean run over an allowlist it could not read.
  writeAllowlist("{ not json");
  assertRejected(runPolicy(root), /style-policy\/configuration/);

  // A file that parses but whose entries do not hold up: an entry the command
  // cannot validate must not end up authorizing anything.
  writeAllowlist(
    JSON.stringify({
      ...EMPTY_ALLOWLIST,
      classDependencies: [{ ...entry, token: " ", count: 0 }],
    }),
  );
  assertRejected(
    runPolicy(root),
    /must have exact file, token, and a positive integer count/,
  );

  writeAllowlist(
    JSON.stringify({
      ...EMPTY_ALLOWLIST,
      classDependencies: [{ ...entry, rationale: "" }],
    }),
  );
  assertRejected(runPolicy(root), /must have a non-empty rationale/);

  writeAllowlist(JSON.stringify({ ...EMPTY_ALLOWLIST, version: 2 }));
  assertRejected(runPolicy(root), /style-allowlist\.json version must be 1/);
});
