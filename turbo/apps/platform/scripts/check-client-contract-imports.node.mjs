import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ESLint } from "eslint";

const platformRoot = path.resolve(import.meta.dirname, "..");
const ruleId = "client-contracts/prefer-client-descriptors";

function createLinters() {
  return {
    platform: new ESLint({
      cwd: platformRoot,
      allowInlineConfig: false,
      fix: true,
    }),
    core: new ESLint({
      cwd: path.resolve(platformRoot, "../../packages/core"),
      allowInlineConfig: false,
      fix: true,
    }),
    contracts: new ESLint({
      cwd: path.resolve(platformRoot, "../../packages/api-contracts"),
      allowInlineConfig: false,
      fix: true,
    }),
  };
}

async function lint(eslint, source, filePath) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.ok(result);
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return {
    result,
    violations: result.messages.filter((message) => {
      return message.ruleId === ruleId;
    }),
  };
}

await test("App fixes use generated router, validator, and type destinations", async () => {
  const { platform } = createLinters();
  const source = `
      import { agentsMainContract, agentVisibilitySchema, type AgentVisibility } from "@okouai/api-contracts/contracts/agents";
      import { apiClient$ } from "./api-client.ts";
      import { computed } from "ccstate";
      export const client$ = computed((get) => { return get(apiClient$)(agentsMainContract); });
      export function visibility(value: AgentVisibility) { return agentVisibilitySchema.parse(value); }
    `;
  const { result, violations } = await lint(
    platform,
    source,
    "src/signals/lint-contract-fixture.ts",
  );
  assert.deepEqual(violations, []);
  assert.ok(result.output);
  assert.match(result.output, /api-contracts\/client\/agents/u);
  assert.match(result.output, /api-contracts\/validators\/agents/u);
  assert.match(result.output, /import type/u);
  assert.match(result.output, /agentVisibilitySchema\.parse\(value\)/u);
  const second = await lint(
    platform,
    result.output,
    "src/signals/lint-contract-fixture.ts",
  );
  assert.deepEqual(second.violations, []);
  assert.equal(second.result.output, undefined);
});

await test("schema type queries retain the original source as an erased import", async () => {
  const { platform } = createLinters();
  const { result, violations } = await lint(
    platform,
    `import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
       export type BodySchema = typeof agentsMainContract.create.body;`,
    "src/signals/lint-schema-type-fixture.ts",
  );
  assert.deepEqual(violations, []);
  assert.match(result.output ?? "", /import type/u);
  assert.match(result.output ?? "", /contracts\/agents/u);
  assert.doesNotMatch(result.output ?? "", /client\/agents/u);
});

await test("runtime schema parsing is reported without an unsafe fix", async () => {
  const { platform } = createLinters();
  const { result, violations } = await lint(
    platform,
    `import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
       export function parse(value) { return agentsMainContract.create.body.safeParse(value); }`,
    "src/signals/lint-schema-runtime-fixture.ts",
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].messageId, "manualMigration");
  assert.equal(result.output, undefined);
});

await test("Core helper imports move without changing the compatibility barrels", async () => {
  const { core } = createLinters();
  const { result, violations } = await lint(
    core,
    `import { ONBOARDING_INDUSTRY_IDS } from "@okouai/api-contracts/contracts/onboarding";
       export const industries = ONBOARDING_INDUSTRY_IDS;`,
    "src/lint-contract-fixture.ts",
  );
  assert.deepEqual(violations, []);
  assert.match(result.output ?? "", /validators\/onboarding/u);
  for (const filePath of ["src/index.ts", "src/contracts/index.ts"]) {
    const compatibility = await lint(
      core,
      'export * from "@okouai/api-contracts/contracts";',
      filePath,
    );
    assert.deepEqual(compatibility.violations, []);
  }
});

await test("relative validator imports and descriptor files share the boundary", async () => {
  const { contracts } = createLinters();
  const independent = await lint(
    contracts,
    `import { agentVisibilitySchema } from "../contracts/agents";
       export const visibility = agentVisibilitySchema;`,
    "src/validators/lint-contract-fixture.ts",
  );
  assert.deepEqual(independent.violations, []);
  assert.ok(independent.result.output);
  assert.doesNotMatch(
    independent.result.output,
    /from ["']\.\.\/contracts\/agents["']/u,
  );
  const descriptor = await lint(
    contracts,
    `import { agentsMainContract } from "../contracts/agents";
       export const leaked = agentsMainContract;`,
    "src/client/agents.ts",
  );
  assert.equal(descriptor.violations.length, 1);
  const server = await lint(
    contracts,
    `import { agentsMainContract } from "./agents";
       export const original = agentsMainContract;`,
    "src/contracts/lint-contract-fixture.ts",
  );
  assert.deepEqual(server.violations, []);
});

await test("full-schema test and mock imports remain outside the production policy", async () => {
  const { platform, core, contracts } = createLinters();
  const source = `import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
      export const fixture = agentsMainContract;`;
  for (const filePath of [
    "src/signals/__tests__/lint-contract-fixture.test.ts",
    "src/mocks/lint-contract-fixture.ts",
    "src/test/lint-contract-fixture.ts",
  ]) {
    const { violations } = await lint(platform, source, filePath);
    assert.deepEqual(violations, [], filePath);
  }
  for (const [eslint, filePath] of [
    [core, "src/__tests__/lint-contract-fixture.test.ts"],
    [contracts, "src/validators/__tests__/lint-contract-fixture.test.ts"],
  ]) {
    const { violations } = await lint(eslint, source, filePath);
    assert.deepEqual(violations, [], filePath);
  }
});
