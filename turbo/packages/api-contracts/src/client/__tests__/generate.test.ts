import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentInstructionsContract as sourceAgentInstructionsContract,
  agentsByIdContract as sourceAgentsByIdContract,
  agentsMainContract as sourceAgentsMainContract,
} from "../../contracts/agents";
import type { AppRouter } from "../../contracts/trpc-contract";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
} from "../agents";
import {
  generateClientDescriptors,
  renderAgentsClientDescriptors,
} from "../generate";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agents-client-descriptors-"));
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

describe("agents client descriptor generation", () => {
  it.each([
    {
      name: "agentsMainContract",
      descriptor: agentsMainContract,
      source: sourceAgentsMainContract,
    },
    {
      name: "agentsByIdContract",
      descriptor: agentsByIdContract,
      source: sourceAgentsByIdContract,
    },
    {
      name: "agentInstructionsContract",
      descriptor: agentInstructionsContract,
      source: sourceAgentInstructionsContract,
    },
  ])(
    "projects every route in $name from the source contract",
    ({ descriptor, source }) => {
      expect(descriptor).toEqual(projectRoutes(source));
    },
  );

  it("renders deterministic source matching the checked-in descriptors", async () => {
    const rendered = renderAgentsClientDescriptors();
    expect(renderAgentsClientDescriptors()).toBe(rendered);
    expect(
      await readFile(new URL("../agents.ts", import.meta.url), "utf8"),
    ).toBe(rendered);

    const outputPath = join(directory, "agents.ts");
    await generateClientDescriptors({ outputPath });
    expect(await readFile(outputPath, "utf8")).toBe(rendered);
  });

  it("checks fresh output without rewriting it", async () => {
    const outputPath = join(directory, "agents.ts");
    await generateClientDescriptors({ outputPath });
    await utimes(outputPath, 0, 0);
    const original = await stat(outputPath);

    await generateClientDescriptors({ check: true, outputPath });

    expect(await readFile(outputPath, "utf8")).toBe(
      renderAgentsClientDescriptors(),
    );
    expect((await stat(outputPath)).mtimeMs).toBe(original.mtimeMs);
  });

  it("reports stale or missing output without changing files", async () => {
    const outputPath = join(directory, "agents.ts");
    await expect(
      generateClientDescriptors({ check: true, outputPath }),
    ).rejects.toThrow("out of date");
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const stale = "// Previous generated output\n";
    await writeFile(outputPath, stale);
    await utimes(outputPath, 0, 0);
    const original = await stat(outputPath);

    await expect(
      generateClientDescriptors({ check: true, outputPath }),
    ).rejects.toThrow("out of date");
    expect(await readFile(outputPath, "utf8")).toBe(stale);
    expect((await stat(outputPath)).mtimeMs).toBe(original.mtimeMs);

    await generateClientDescriptors({ outputPath });
    await generateClientDescriptors({ check: true, outputPath });
    expect(await readFile(outputPath, "utf8")).toBe(
      renderAgentsClientDescriptors(),
    );
  });
});
