import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverClientContractImportModules } from "../import-metadata";
import { clientContractImportManifest } from "../imports";

let directory: string;
let sourceDirectory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "client-contract-imports-"));
  sourceDirectory = join(directory, "contracts");
  await mkdir(sourceDirectory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function source(path: string, text: string): Promise<void> {
  const file = join(directory, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function routeModule(module: string, ...names: string[]) {
  return {
    module,
    contracts: names.map((name) => {
      return { name };
    }),
  };
}

describe("client contract import metadata", () => {
  it("follows public imports, reexports, and immutable identifier aliases without evaluating modules", async () => {
    await source(
      "validators/original.ts",
      [
        'throw new Error("Source modules must not be evaluated");',
        "export const schema = makeSchema();",
        "export const SAME_VALUE = 128;",
        "const internal = makeSchema();",
        "export { internal as published };",
        "export function helper() {}",
      ].join("\n"),
    );
    await source("validators/other.ts", "export const SAME_VALUE = 128;");
    await source(
      "contracts/pure.ts",
      'export { schema as renamed, SAME_VALUE, published, helper } from "../validators/original";',
    );
    await source(
      "contracts/route.ts",
      [
        'import { renamed as imported, helper } from "./pure.js";',
        'import { SAME_VALUE as otherValue } from "../validators/other";',
        "const first = imported;",
        "const second = ((first));",
        "export const originalSchema = second;",
        "export { first as exportedSchema, helper, otherValue };",
        'export { SAME_VALUE, published } from "./pure";',
        "export const routes = makeRouter();",
      ].join("\n"),
    );
    const modules = [routeModule("route", "routes")];
    const options = { sourceDirectory, modules };
    const result = await discoverClientContractImportModules(options);
    expect(await discoverClientContractImportModules(options)).toEqual(result);
    expect(result).toEqual([
      {
        module: "route",
        contracts: ["routes"],
        bindings: [
          {
            name: "SAME_VALUE",
            source: "validators/original",
            imported: "SAME_VALUE",
          },
          {
            name: "exportedSchema",
            source: "validators/original",
            imported: "schema",
          },
          {
            name: "helper",
            source: "validators/original",
            imported: "helper",
          },
          {
            name: "originalSchema",
            source: "validators/original",
            imported: "schema",
          },
          {
            name: "otherValue",
            source: "validators/other",
            imported: "SAME_VALUE",
          },
          {
            name: "published",
            source: "validators/original",
            imported: "published",
          },
        ],
      },
    ]);
  });

  it("leaves mutable, private, cyclic, expression, external, and router-bearing origins unmapped", async () => {
    await source(
      "validators/original.ts",
      [
        "export const schema = makeSchema();",
        "export let mutable = schema;",
        "const privateSchema = makeSchema();",
        "export const cycleFirst = cycleSecond;",
        "const cycleSecond = cycleFirst;",
      ].join("\n"),
    );
    await source(
      "contracts/other-route.ts",
      "export const otherRoutes = makeRouter(); export const schema = makeSchema();",
    );
    await source(
      "contracts/forwarded-route.ts",
      'export { otherRoutes } from "./other-route"; export const forwardedSchema = makeSchema();',
    );
    await source(
      "contracts/index.ts",
      "export const rootSchema = makeSchema();",
    );
    await source("external.ts", "export const externalSchema = makeSchema();");
    await source(
      "contracts/route.ts",
      [
        'import { schema } from "../validators/original";',
        'import * as validators from "../validators/original";',
        "let mutableAlias = schema;",
        "const cycleFirst = cycleSecond;",
        "const cycleSecond = cycleFirst;",
        "export { mutableAlias, cycleFirst };",
        'export { privateSchema, mutable, cycleFirst as remoteCycle } from "../validators/original";',
        'export { schema as routerSchema } from "./other-route";',
        'export { forwardedSchema } from "./forwarded-route";',
        'export { rootSchema } from "./index";',
        'export { externalSchema } from "../external";',
        'export { missingSchema } from "../validators/missing";',
        'export { external } from "external-package";',
        'export type { schema as exportedType } from "../validators/original";',
        'import type { schema as importedType } from "../validators/original";',
        "export { importedType };",
        "export const localSchema = makeSchema();",
        "export const wrappedSchema = identity(schema);",
        "export const namespaceSchema = validators.schema;",
        "export const closureSchema = () => schema;",
        "export const assertedSchema = schema as unknown;",
        "export const annotatedSchema: unknown = schema;",
        "export const nonnullSchema = schema!;",
        "export const checkedSchema = schema satisfies unknown;",
        "export const routes = makeRouter();",
      ].join("\n"),
    );
    expect(
      await discoverClientContractImportModules({
        sourceDirectory,
        modules: [
          routeModule("route", "routes"),
          routeModule("other-route", "otherRoutes"),
        ],
      }),
    ).toEqual([
      { module: "other-route", contracts: ["otherRoutes"], bindings: [] },
      { module: "route", contracts: ["routes"], bindings: [] },
    ]);
  });

  it("preserves type views declared by the independent defining export", async () => {
    await source(
      "validators/typed.ts",
      [
        "const schema = makeSchema();",
        "export const annotated: unknown = schema;",
        "export const asserted = schema as unknown;",
      ].join("\n"),
    );
    await source(
      "contracts/route.ts",
      'export { annotated, asserted } from "../validators/typed";',
    );
    expect(
      await discoverClientContractImportModules({
        sourceDirectory,
        modules: [routeModule("route", "routes")],
      }),
    ).toEqual([
      {
        module: "route",
        contracts: ["routes"],
        bindings: [
          {
            name: "annotated",
            source: "validators/typed",
            imported: "annotated",
          },
          {
            name: "asserted",
            source: "validators/typed",
            imported: "asserted",
          },
        ],
      },
    ]);
  });

  it("handles star exports conservatively and resolves pure defining exports", async () => {
    await source(
      "contracts/pure.ts",
      [
        "export const schema = makeSchema();",
        "export const conflict = 1;",
        "export default schema;",
      ].join("\n"),
    );
    await source("validators/other.ts", "export const conflict = 1;");
    await source(
      "contracts/forward.ts",
      'export * from "./pure"; export * from "./cycle";',
    );
    await source("contracts/cycle.ts", 'export * from "./forward";');
    await source(
      "contracts/route.ts",
      [
        'export * from "./forward";',
        'export * from "./pure";',
        'export * from "../validators/other";',
        'export type * from "../validators/other";',
        'export { schema as explicit } from "./pure";',
        "export const zRoutes = makeRouter();",
        "export const aRoutes = makeRouter();",
      ].join("\n"),
    );
    expect(
      await discoverClientContractImportModules({
        sourceDirectory,
        modules: [routeModule("route", "zRoutes", "aRoutes")],
      }),
    ).toEqual([
      {
        module: "route",
        contracts: ["aRoutes", "zRoutes"],
        bindings: [
          { name: "explicit", source: "contracts/pure", imported: "schema" },
          { name: "schema", source: "contracts/pure", imported: "schema" },
        ],
      },
    ]);
  });

  it("does not substitute star candidates for unknown or unsupported public bindings", async () => {
    await source(
      "validators/known.ts",
      [
        "export const conflicted = 1;",
        "export const directUnknown = 1;",
        "export const mutable = 1;",
        "export const destructured = 1;",
        "export const namespace = 1;",
        "export const safe = 1;",
      ].join("\n"),
    );
    await source(
      "validators/unknown.ts",
      'export { external as conflicted } from "external-package";',
    );
    await source(
      "contracts/route.ts",
      [
        'export * from "../validators/known";',
        'export * from "../validators/unknown";',
        'export { external as directUnknown } from "external-package";',
        "export let mutable = 1;",
        "export const { destructured } = getValues();",
        'export * as namespace from "../validators/known";',
        "export const routes = makeRouter();",
      ].join("\n"),
    );
    await source(
      "contracts/external-route.ts",
      [
        'export * from "../validators/known";',
        'export * from "external-package";',
        'export { safe } from "../validators/known";',
        "export const externalRoutes = makeRouter();",
      ].join("\n"),
    );
    expect(
      await discoverClientContractImportModules({
        sourceDirectory,
        modules: [
          routeModule("route", "routes"),
          routeModule("external-route", "externalRoutes"),
        ],
      }),
    ).toEqual([
      {
        module: "external-route",
        contracts: ["externalRoutes"],
        bindings: [
          { name: "safe", source: "validators/known", imported: "safe" },
        ],
      },
      {
        module: "route",
        contracts: ["routes"],
        bindings: [
          { name: "safe", source: "validators/known", imported: "safe" },
        ],
      },
    ]);
  });

  it("includes moved original schemas, borrowed constants, and the renamed composer draft", () => {
    const bindings = (module: string) => {
      return clientContractImportManifest.find((entry) => {
        return entry.module === module;
      })?.bindings;
    };
    expect(bindings("agents")).toContainEqual({
      name: "agentVisibilitySchema",
      source: "validators/agents",
      imported: "agentVisibilitySchema",
    });
    expect(bindings("chat-threads")).toContainEqual({
      name: "chatThreadDraftSchema",
      source: "validators/chat-threads",
      imported: "composerDraftSchema",
    });
    expect(bindings("ssh-connections")).toContainEqual({
      name: "SSH_DISPLAY_NAME_MAX_LENGTH",
      source: "validators/ssh-credentials",
      imported: "SSH_DISPLAY_NAME_MAX_LENGTH",
    });
    expect(bindings("vnc-connections")).toContainEqual({
      name: "VNC_HOST_MAX_LENGTH",
      source: "contracts/vnc-transport",
      imported: "VNC_HOST_MAX_LENGTH",
    });
    const routeModules = new Set<string>(
      clientContractImportManifest.map(({ module }) => {
        return `contracts/${module}`;
      }),
    );
    for (const { bindings: entries } of clientContractImportManifest) {
      for (const { source } of entries) {
        expect(routeModules.has(source)).toBe(false);
      }
    }
  });
});
