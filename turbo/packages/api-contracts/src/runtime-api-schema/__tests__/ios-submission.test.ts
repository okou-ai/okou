import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ClientResponseTransform } from "../../client-transforms/types";
import { runRuntimeApiSchemaCli } from "../command";
import { checkIosSubmission } from "../ios-submission";
import type {
  RuntimeApiRouteSnapshot,
  RuntimeApiSchemaDocument,
} from "../schema";

const build = { version: "0.73.0", build: "252", commit: "a".repeat(40) };
const route: RuntimeApiRouteSnapshot = {
  owner: "ios",
  id: "ios.example",
  method: "GET",
  path: "/api/example",
  request: {},
  responses: { "200": { kind: "json-schema", schema: { type: "string" } } },
};
const submitted: RuntimeApiSchemaDocument = {
  schemaFormatVersion: 1,
  packageName: "@okouai/api-contracts",
  packageVersion: "1.0.0",
  generatedAt: "2026-11-27T00:00:00Z",
  routes: [route],
};
const transform: ClientResponseTransform = {
  client: "ios",
  method: route.method,
  path: route.path,
  status: 200,
  maxVersion: build.version,
  since: "#1",
  transform: (body) => {
    return String(body);
  },
};

describe("submitted iOS build compatibility", () => {
  let dir: string;
  let manifest: string;
  let snapshot: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ios-submission-"));
    manifest = join(dir, "build.json");
    snapshot = join(dir, `${build.commit}.json.gz`);
    await writeFile(manifest, JSON.stringify(build));
    await writeFile(snapshot, gzipSync(JSON.stringify(submitted)));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks a removed route even after both production and main have dropped it", async () => {
    const current = join(dir, "current.json");
    const floor = join(dir, "floor.json");
    const report = join(dir, "report.json");
    const newRoute = { ...route, id: "ios.new", path: "/api/new" };
    await writeFile(
      current,
      JSON.stringify({
        ...submitted,
        routes: [newRoute],
      }),
    );
    await writeFile(
      floor,
      JSON.stringify({
        appStoreMinimumSupportedVersion: null,
        testFlightMinimumSupportedVersion: "0.74.0",
      }),
    );
    const args = [
      "lint",
      "--against",
      current,
      "--base-schema",
      current,
      "--current",
      current,
      "--block-owner",
      "ios",
      "--ios-floor",
      floor,
      "--ios-base-floor",
      floor,
      "--ios-submission",
      manifest,
      "--report-out",
      report,
    ];
    expect(await runRuntimeApiSchemaCli(args)).toBe(1);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      findings: [],
      errors: [
        {
          kind: "ios-submission-incompatible",
          message: expect.stringContaining(
            "Submitted iOS 0.73.0 (252): GET /api/example",
          ),
        },
      ],
    });
    await writeFile(
      current,
      JSON.stringify({ ...submitted, routes: [route, newRoute] }),
    );
    expect(await runRuntimeApiSchemaCli(args)).toBe(0);
  });

  it("accepts a body transform only when the submitted build receives it", async () => {
    const changed: RuntimeApiSchemaDocument = {
      ...submitted,
      routes: [
        {
          ...route,
          responses: {
            "200": { kind: "json-schema", schema: { type: "number" } },
          },
        },
      ],
    };
    expect(
      await checkIosSubmission(manifest, changed, build.version, [transform]),
    ).toEqual([]);
    expect(
      await checkIosSubmission(manifest, changed, build.version, [
        { ...transform, maxVersion: "0.72.9" },
      ]),
    ).toContainEqual(expect.stringContaining("responses.200"));
  });

  it("blocks an unknown success status, a newly required request field, and a floor that rejects the build", async () => {
    const changed: RuntimeApiSchemaDocument = {
      ...submitted,
      routes: [
        {
          ...route,
          request: {
            query: {
              kind: "json-schema",
              schema: {
                type: "object",
                properties: { page: { type: "number" } },
                required: ["page"],
              },
            },
          },
          responses: { ...route.responses, "201": route.responses["200"]! },
        },
      ],
    };
    const errors = await checkIosSubmission(manifest, changed, "0.73.1", [
      { ...transform, status: 201 },
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HTTP 426"),
        expect.stringContaining("request.query"),
        expect.stringContaining("responses.201"),
      ]),
    );
  });

  it("requires a readable, nonempty snapshot for the pinned commit", async () => {
    await writeFile(
      snapshot,
      gzipSync(JSON.stringify({ ...submitted, routes: [] })),
    );
    await expect(
      checkIosSubmission(manifest, submitted, null, []),
    ).rejects.toThrow("nonempty iOS-only API snapshot");
    await rm(snapshot);
    await expect(
      checkIosSubmission(manifest, submitted, null, []),
    ).rejects.toThrow("ENOENT");
  });
});
