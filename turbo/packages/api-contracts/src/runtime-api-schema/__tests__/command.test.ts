import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeApiSchemaCli } from "../command";
import type { RuntimeApiRouteOwner } from "../routes";
import {
  runtimeApiSchemaFormatVersion,
  type RuntimeApiSchemaDocument,
} from "../schema";

function document(
  owner: RuntimeApiRouteOwner,
  required: readonly string[],
): RuntimeApiSchemaDocument {
  return {
    schemaFormatVersion: runtimeApiSchemaFormatVersion,
    packageName: "@okouai/api-contracts",
    packageVersion: "0.0.0",
    generatedAt: "2026-10-10T00:00:00.000Z",
    routes: [
      {
        id: `${owner}.example`,
        owner,
        method: "GET",
        path: "/api/desktop/compatibility",
        request: {},
        responses: {
          "200": {
            kind: "json-schema",
            schema: {
              type: "object",
              properties: { minimumSupportedVersion: { type: "string" } },
              required: [...required],
            },
          },
        },
      },
    ],
  };
}

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runtime-api-schema-cli-"));
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((message: string) => {
    stdout.push(message);
  });
  vi.spyOn(console, "warn").mockImplementation((message: string) => {
    stderr.push(message);
  });
  vi.spyOn(console, "error").mockImplementation((message: string) => {
    stderr.push(message);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function writeJson(name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function lint(
  owner: RuntimeApiRouteOwner,
  extra: readonly string[] = [],
): Promise<number> {
  const online = await writeJson(
    "online.json",
    document(owner, ["minimumSupportedVersion"]),
  );
  const current = await writeJson("current.json", document(owner, []));
  return runRuntimeApiSchemaCli([
    "lint",
    "--",
    "--against",
    online,
    "--current",
    current,
    ...extra,
  ]);
}

async function floors(
  floor: string | null,
  baseFloor: string | null,
): Promise<readonly string[]> {
  return [
    "--desktop-floor",
    await writeJson("floor.json", { minimumSupportedVersion: floor }),
    "--desktop-base-floor",
    await writeJson("base-floor.json", { minimumSupportedVersion: baseFloor }),
  ];
}

describe("runtime API schema CLI lint", () => {
  it("exits 1 for an unproven Desktop finding and prints both proofs", async () => {
    const reportOut = join(dir, "report.json");

    await expect(
      lint("desktop", [
        "--block-owner",
        "desktop",
        "--report-out",
        reportOut,
        ...(await floors("0.51.0", "0.51.0")),
        "--desktop-published-version",
        "0.52.2",
      ]),
    ).resolves.toBe(1);

    const output = stdout.join("\n");
    expect(output).toContain(
      "turbo/apps/api/src/lib/desktop-compatibility.json",
    );
    expect(output).toContain(
      "turbo/packages/api-contracts/src/client-transforms/desktop.ts",
    );
    expect(stderr.join("\n")).toContain(
      "::error title=Runtime API compatibility break::GET /api/desktop/compatibility",
    );
    const report = JSON.parse(await readFile(reportOut, "utf8"));
    expect(report).toMatchObject({
      passed: false,
      findings: [{ owner: "desktop", outcome: "blocking" }],
    });
  });

  it("exits 0 when the Desktop floor is raised to the published version", async () => {
    await expect(
      lint("desktop", [
        "--block-owner",
        "desktop",
        ...(await floors("0.52.2", "0.51.0")),
        "--desktop-published-version",
        "0.52.2",
      ]),
    ).resolves.toBe(0);
  });

  it("exits 0 and warns for owners that are not blocking", async () => {
    await expect(lint("runner", ["--block-owner", "desktop"])).resolves.toBe(0);

    expect(stderr.join("\n")).toContain(
      "::warning title=Runtime API compatibility (warning)::",
    );
  });

  it("accepts repeated --block-owner options", async () => {
    await expect(
      lint("runner", ["--block-owner", "desktop", "--block-owner", "runner"]),
    ).resolves.toBe(1);
  });

  it("checks the Desktop floor when no online schema is available", async () => {
    const current = await writeJson("current.json", document("desktop", []));

    await expect(
      runRuntimeApiSchemaCli([
        "lint",
        "--against",
        join(dir, "missing.json"),
        "--current",
        current,
        "--block-owner",
        "desktop",
        ...(await floors("0.51.0", "0.52.0")),
        "--desktop-published-version",
        "0.52.2",
      ]),
    ).resolves.toBe(1);

    expect(stderr.join("\n")).toContain(
      "lowers it below the base branch floor",
    );
  });

  it.each([
    [["--warn-only"], "Unknown option: --warn-only"],
    [["--block-owner", "ios"], "Unknown --block-owner value: ios"],
    [["--block-owner"], "Option --block-owner requires a value"],
    [
      ["--desktop-floor", "floor.json"],
      "--desktop-floor and --desktop-base-floor must be passed together",
    ],
  ])("exits 2 for invalid options %j", async (extra, message) => {
    await expect(lint("desktop", extra)).resolves.toBe(2);

    expect(stderr.join("\n")).toContain(message);
  });
});
