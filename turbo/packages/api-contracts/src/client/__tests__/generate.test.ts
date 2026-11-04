import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppRouter } from "../../contracts/trpc-contract";
import {
  discoverClientContractModules,
  generateClientDescriptors,
  renderAgentsClientDescriptors,
  renderClientContractImportManifest,
  renderClientDescriptorManifest,
  renderClientDescriptorModule,
  renderClientDescriptorTestingRegistry,
} from "../generate";
import { discoverClientContractImportModules } from "../import-metadata";
import { clientContractImportManifest } from "../imports";
import { clientDescriptorManifest } from "../manifest";
import { clientDescriptorContracts } from "../testing";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "http-client-descriptors-"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function projectRoutes(source: AppRouter) {
  return Object.fromEntries(
    Object.entries(source).map(([name, route]) => {
      return [
        name,
        {
          method: route.method,
          path: route.path,
          ...(route.contentType === undefined
            ? {}
            : { contentType: route.contentType }),
          statuses: Object.fromEntries(
            Object.keys(route.responses).map((status) => {
              return [status, true];
            }),
          ),
        },
      ];
    }),
  );
}

function runtimeImports(source: string): string[] {
  const parsed = ts.createSourceFile(
    "descriptor.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return parsed.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly
    ) {
      return [];
    }
    return [statement.moduleSpecifier.getText(parsed)];
  });
}

describe("HTTP client descriptor generation", () => {
  it("projects every registered router from its canonical source", async () => {
    const modules = await discoverClientContractModules();
    expect(clientDescriptorManifest).toEqual(
      modules.map(({ module, contracts }) => {
        return {
          module,
          contracts: contracts.map(({ name }) => {
            return name;
          }),
        };
      }),
    );
    expect(clientDescriptorContracts).toHaveLength(
      modules.reduce((count, module) => {
        return count + module.contracts.length;
      }, 0),
    );
    for (const [descriptor, source] of clientDescriptorContracts) {
      expect(descriptor).toEqual(projectRoutes(source));
    }
  });

  it("discovers structurally typed and aliased router exports", async () => {
    await writeFile(
      join(directory, "wrapped.ts"),
      [
        'const runtime = { read: { method: "GET", path: "/wrapped", responses: { 200: {} } } };',
        "function wrap<T>(value: T): T { return value; }",
        "export const wrapped = wrap(runtime);",
        "const aliased = runtime;",
        "export { aliased as published };",
      ].join("\n"),
    );
    const modules = await discoverClientContractModules({
      sourceDirectory: directory,
    });
    expect(
      modules.map(({ module, contracts }) => {
        return {
          module,
          names: contracts.map(({ name }) => {
            return name;
          }),
        };
      }),
    ).toEqual([{ module: "wrapped", names: ["published", "wrapped"] }]);
  });

  it("renders deterministic schema-free production modules and a test registry", async () => {
    const modules = await discoverClientContractModules();
    for (const module of modules) {
      const expected = renderClientDescriptorModule(module);
      expect(renderClientDescriptorModule(module)).toBe(expected);
      expect(
        await readFile(
          new URL(`../${module.module}.ts`, import.meta.url),
          "utf8",
        ),
      ).toBe(expected);
      expect(runtimeImports(expected)).toEqual([]);
    }
    expect(
      await readFile(new URL("../manifest.ts", import.meta.url), "utf8"),
    ).toBe(renderClientDescriptorManifest(modules));
    expect(runtimeImports(renderClientDescriptorManifest(modules))).toEqual([]);
    expect(
      await readFile(new URL("../testing.ts", import.meta.url), "utf8"),
    ).toBe(renderClientDescriptorTestingRegistry(modules));
    expect(
      await readFile(new URL("../agents.ts", import.meta.url), "utf8"),
    ).toBe(renderAgentsClientDescriptors());
  });

  it("renders deterministic schema-free contract import metadata", async () => {
    const modules = await discoverClientContractModules();
    const importModules = await discoverClientContractImportModules({
      modules,
      sourceDirectory: fileURLToPath(
        new URL("../../contracts/", import.meta.url),
      ),
    });
    expect(clientContractImportManifest).toEqual(importModules);
    const importManifest = renderClientContractImportManifest(importModules);
    expect(renderClientContractImportManifest(importModules)).toBe(
      importManifest,
    );
    expect(
      await readFile(new URL("../imports.ts", import.meta.url), "utf8"),
    ).toBe(importManifest);
    expect(runtimeImports(importManifest)).toEqual([]);
  });

  it("checks all fresh outputs without rewriting them", async () => {
    const sourceDirectory = join(directory, "contracts");
    const outputDirectory = join(directory, "client");
    await mkdir(sourceDirectory);
    await writeFile(
      join(sourceDirectory, "first.ts"),
      'export const routes = { get: { method: "GET", path: "/first", responses: { 200: {} } } };\n',
    );
    await writeFile(
      join(sourceDirectory, "second.ts"),
      'export const routes = { create: { method: "POST", path: "/second", responses: { 201: {}, 409: {} } } };\n',
    );
    const options = { sourceDirectory, outputDirectory };
    await generateClientDescriptors(options);
    const paths = (await readdir(outputDirectory)).sort();
    expect(paths).toEqual([
      "first.ts",
      "imports.ts",
      "manifest.ts",
      "second.ts",
      "testing.ts",
    ]);
    for (const name of paths) {
      await utimes(join(outputDirectory, name), 0, 0);
    }

    await generateClientDescriptors({ ...options, check: true });

    for (const name of paths) {
      expect((await stat(join(outputDirectory, name))).mtimeMs).toBe(0);
    }
  });

  it("reports missing, stale, and obsolete outputs without changing them", async () => {
    const sourceDirectory = join(directory, "contracts");
    const outputDirectory = join(directory, "client");
    await mkdir(sourceDirectory);
    await writeFile(
      join(sourceDirectory, "first.ts"),
      'export const routes = { get: { method: "GET", path: "/first", responses: { 200: {} } } };\n',
    );
    const options = { sourceDirectory, outputDirectory };
    await expect(
      generateClientDescriptors({ ...options, check: true }),
    ).rejects.toThrow("out of date");
    await expect(
      readFile(join(outputDirectory, "first.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await generateClientDescriptors(options);
    const stale = "// Previous generated output\n";
    const stalePath = join(outputDirectory, "first.ts");
    await writeFile(stalePath, stale);
    await utimes(stalePath, 0, 0);
    await expect(
      generateClientDescriptors({ ...options, check: true }),
    ).rejects.toThrow("first.ts");
    expect(await readFile(stalePath, "utf8")).toBe(stale);
    expect((await stat(stalePath)).mtimeMs).toBe(0);

    await generateClientDescriptors(options);
    const metadataPath = join(outputDirectory, "imports.ts");
    const metadata = await readFile(metadataPath, "utf8");
    await rm(metadataPath);
    await expect(
      generateClientDescriptors({ ...options, check: true }),
    ).rejects.toThrow("imports.ts");
    await expect(readFile(metadataPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await generateClientDescriptors(options);
    expect(await readFile(metadataPath, "utf8")).toBe(metadata);
    await writeFile(metadataPath, stale);
    await expect(
      generateClientDescriptors({ ...options, check: true }),
    ).rejects.toThrow("imports.ts");
    expect(await readFile(metadataPath, "utf8")).toBe(stale);

    await generateClientDescriptors(options);
    const obsoletePath = join(outputDirectory, "obsolete.ts");
    const obsolete = await readFile(stalePath, "utf8");
    await writeFile(obsoletePath, obsolete);
    await expect(
      generateClientDescriptors({ ...options, check: true }),
    ).rejects.toThrow("obsolete.ts");
    expect(await readFile(obsoletePath, "utf8")).toBe(obsolete);

    await generateClientDescriptors(options);
    await generateClientDescriptors({ ...options, check: true });
    await expect(readFile(obsoletePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
