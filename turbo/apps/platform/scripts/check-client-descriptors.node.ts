import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { clientDescriptorsPlugin } from "./check-client-descriptors.ts";

const CONTRACT_SOURCE = "packages/api-contracts/src";
const DESCRIPTOR = `${CONTRACT_SOURCE}/client/agents.ts`;
const FULL_CONTRACT = `${CONTRACT_SOURCE}/contracts/agents.ts`;
const VALIDATORS = `${CONTRACT_SOURCE}/validators/agents.ts`;
const DESCRIPTOR_SOURCE = `
import type { agents } from "../contracts/agents.ts";
export const agentsClient = {
  method: "GET", path: "/api/agents", statuses: { 200: true },
} satisfies Pick<typeof agents, "method" | "path"> & { statuses: Record<number, true> };
`;
const MAIN_SOURCE = `
import { agentsClient } from "./${DESCRIPTOR}";
import { schema } from "./${VALIDATORS}";
globalThis.descriptor = agentsClient;
globalThis.validate = schema.parse;
`;

async function createFixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "okou-client-descriptors-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const write = async (fileName: string, source: string) => {
    const filePath = path.join(root, fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  };
  await write("index.html", '<script type="module" src="/main.ts"></script>');
  await write("main.ts", MAIN_SOURCE);
  await write(DESCRIPTOR, DESCRIPTOR_SOURCE);
  await write(
    FULL_CONTRACT,
    'import { schema } from "../validators/agents.ts"; export const agents = { method: "GET", path: "/api/agents", schema };',
  );
  await write(
    VALIDATORS,
    'import { object, string } from "zod"; export const schema = object({ name: string() });',
  );
  return {
    write,
    build: () => {
      return build({
        configFile: false,
        logLevel: "silent",
        root,
        resolve: {
          alias: { zod: fileURLToPath(import.meta.resolve("zod")) },
        },
        plugins: [clientDescriptorsPlugin()],
        build: { write: false },
      });
    },
  };
}

await test("production descriptors allow type-only contracts and independent validators", async (context) => {
  const fixture = await createFixture(context);
  await assert.doesNotReject(fixture.build);
});

await test("production chunks reject the full agents contract, including lazy imports", async (context) => {
  const fixture = await createFixture(context);
  for (const contractImport of [
    `import { agents } from "./${FULL_CONTRACT}"; globalThis.fullContract = agents;`,
    `globalThis.loadContract = () => import("./${FULL_CONTRACT}");`,
  ]) {
    await fixture.write("main.ts", `${MAIN_SOURCE}\n${contractImport}`);
    await assert.rejects(
      fixture.build,
      /full agents contract reached the production bundle/u,
    );
  }
});

await test("descriptors reject static and dynamic runtime schema dependencies", async (context) => {
  const fixture = await createFixture(context);
  for (const schemaImport of [
    'import "../validators/agents.ts";',
    'void import("../validators/agents.ts");',
  ]) {
    await fixture.write(DESCRIPTOR, `${schemaImport}\n${DESCRIPTOR_SOURCE}`);
    await assert.rejects(
      fixture.build,
      /generated client descriptors must have no runtime imports/u,
    );
  }
});

await test("missing descriptors fail closed instead of silently skipping the graph check", async (context) => {
  const fixture = await createFixture(context);
  await fixture.write(
    "main.ts",
    `import { schema } from "./${VALIDATORS}"; globalThis.validate = schema.parse;`,
  );
  await assert.rejects(
    fixture.build,
    /descriptor is missing from the production bundle graph/u,
  );
});
