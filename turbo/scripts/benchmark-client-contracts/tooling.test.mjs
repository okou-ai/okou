import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanAppImports } from "./cli.mjs";
import { compileScript, evaluateScript, verifyRetained } from "./evaluate.mjs";
import { baselineExpressionRoots } from "./baseline-roots.mjs";

test("a precompiled script evaluates fresh module state and retains its live exports", () => {
  const script = compileScript(`
    globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;
    const initialized = { evaluation: globalThis.evaluations };
    globalThis.__contractsBenchmarkRetained = [initialized];
  `);
  const first = evaluateScript(script);
  const second = evaluateScript(script);
  verifyRetained(first.values, 1);
  verifyRetained(second.values, 1);
  assert.equal(first.values[0].evaluation, 1);
  assert.equal(second.values[0].evaluation, 1);
  assert.notEqual(first.values[0], second.values[0]);
});

test("App AST surface retains runtime exports and reconciles descriptor/validator identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-import-scan-"));
  try {
    await writeFile(
      path.join(root, "app.ts"),
      `
      import { contract as route } from "@okouai/api-contracts/client/example";
      import { schema, Shape, type Other } from "@okouai/api-contracts/validators/example";
      import { initClient } from "@okouai/api-contracts/client/transport";
      import { validateClientResponse } from "@okouai/api-contracts/client/response-validation";
      const typed: Shape | Other | undefined = undefined;
      export const live = [route, schema, initClient, validateClientResponse, typed];
    `,
    );
    await mkdir(path.join(root, "__tests__"));
    await writeFile(
      path.join(root, "__tests__", "page.test.ts"),
      `import { testOnly } from "@okouai/api-contracts/contracts/tests"; console.log(testOnly);`,
    );
    await writeFile(
      path.join(root, "mock-helper.ts"),
      `import { mockOnly } from "@okouai/api-contracts/contracts/mocks"; console.log(mockOnly);`,
    );
    const manifest = await scanAppImports(root, root);
    assert.equal(manifest.scannedFileCount, 1);
    assert.deepEqual(
      manifest.bindings
        .map(({ baseline }) => {
          return baseline;
        })
        .sort((left, right) => {
          return `${left.source}#${left.imported}`.localeCompare(
            `${right.source}#${right.imported}`,
          );
        }),
      [
        {
          source: "@okouai/api-contracts/contracts/example",
          imported: "contract",
        },
        {
          source: "@okouai/api-contracts/contracts/example",
          imported: "schema",
        },
        {
          source: "@okouai/api-contracts/contracts/trpc-contract",
          imported: "initClient",
        },
        {
          source: "@okouai/api-contracts/contracts/trpc-contract",
          imported: "validateResponse",
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App-reachable Core roots and newly named schema fields remain in the comparison", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "contract-core-scan-"));
  const app = path.join(repository, "turbo/apps/platform/src");
  const core = path.join(repository, "turbo/packages/core");
  try {
    await mkdir(app, { recursive: true });
    await mkdir(path.join(core, "src"), { recursive: true });
    await writeFile(
      path.join(core, "package.json"),
      JSON.stringify({ exports: { "./*": { import: "./src/*.ts" } } }),
    );
    await writeFile(
      path.join(app, "app.ts"),
      `
      import { helper } from "@okouai/core/entry";
      import { indicatorsSchema } from "@okouai/api-contracts/validators/chat-threads";
      export const live = [helper, indicatorsSchema];
    `,
    );
    await writeFile(
      path.join(core, "src/entry.ts"),
      `export { helper } from "./nested";`,
    );
    await writeFile(
      path.join(core, "src/nested.ts"),
      `
      import { ONBOARDING_INDUSTRY_IDS } from "@okouai/api-contracts/validators/onboarding";
      export const helper = () => ONBOARDING_INDUSTRY_IDS;
    `,
    );
    const manifest = await scanAppImports(app, repository);
    assert.equal(manifest.scannedAppFileCount, 1);
    assert.equal(manifest.scannedReachableCoreFileCount, 2);
    assert.equal(manifest.bindings.length, 2);
    assert.deepEqual(
      manifest.bindings.find((binding) => {
        return binding.imported === "indicatorsSchema";
      }).baseline,
      baselineExpressionRoots[
        "@okouai/api-contracts/validators/chat-threads#indicatorsSchema"
      ],
    );
    assert.deepEqual(
      manifest.bindings.find((binding) => {
        return binding.imported === "ONBOARDING_INDUSTRY_IDS";
      }).baseline,
      {
        source: "@okouai/api-contracts/contracts/onboarding",
        imported: "ONBOARDING_INDUSTRY_IDS",
      },
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
