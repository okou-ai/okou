import { iosGatePolicy } from "../ios-policy";
import { object, string } from "zod";
import { iosRouteBindings } from "../ios-routes";
import { evaluateRuntimeApiGate, type RuntimeApiGateInput } from "../gate";
import { compareRuntimeApiSchemas } from "../compat";
import {
  buildRuntimeApiSchemaDocument,
  type JsonObject,
  type RuntimeApiRouteSnapshot,
  type RuntimeApiSchemaDocument,
} from "../schema";
import type { ClientResponseTransform } from "../../client-transforms/types";
import { runRuntimeApiSchemaCli } from "../command";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schemaDocument = buildRuntimeApiSchemaDocument();
const iosRoute = schemaDocument.routes.find((route) => {
  return route.id === "ios.chatThreadsContract.snapshot";
})!;

function changedResponse(status: string): RuntimeApiSchemaDocument {
  const document = schemaDocument;
  return {
    ...document,
    routes: [
      {
        ...iosRoute,
        responses: {
          ...iosRoute.responses,
          [status]: {
            kind: "json-schema",
            schema: { type: "object", properties: {}, required: [] },
          },
        },
      },
    ],
  };
}

function gate(overrides: Partial<RuntimeApiGateInput> = {}) {
  return evaluateRuntimeApiGate({
    findings: compareRuntimeApiSchemas(
      { ...schemaDocument, routes: [iosRoute] },
      changedResponse("200"),
    ),
    blockingOwners: new Set(["ios", "desktop"]),
    desktopTransforms: [],
    iosTransforms: [],
    iosAppStoreFloor: { floor: "0.22.5", baseFloor: "0.22.5" },
    iosAppStorePublishedVersion: "0.22.6",
    ...overrides,
  });
}

const transform: ClientResponseTransform = {
  client: "ios",
  method: iosRoute.method,
  path: iosRoute.path,
  status: 200,
  maxVersion: null,
  since: "#1",
  transform: (body) => {
    return body;
  },
};

describe("iOS runtime API contract gate", () => {
  it("blocks a changed real iOS response and names the iOS proofs", () => {
    const result = gate();
    expect(result.passed).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(
      result.findings.every((finding) => {
        return finding.outcome === "blocking";
      }),
    ).toBe(true);
    expect(result.findings[0]?.proofs).toContain(
      "ios-client-compatibility.json",
    );
    expect(result.findings[0]?.proofs).toContain("client-transforms/ios.ts");
  });

  it("keeps shared endpoint ownership separate and requires a proof for each native client", () => {
    const routes = schemaDocument.routes.filter((route) => {
      return route.path === "/api/feature-switches";
    });
    expect(
      routes
        .map((route) => {
          return route.owner;
        })
        .sort(),
    ).toEqual(["android", "desktop", "ios"]);
    const findings = compareRuntimeApiSchemas(
      { ...schemaDocument, routes },
      { ...schemaDocument, routes: [] },
    );
    const result = gate({
      findings,
      blockingOwners: new Set(["android", "desktop", "ios"]),
      androidFloor: { floor: null, baseFloor: null },
      iosAppStoreFloor: { floor: "0.22.6", baseFloor: "0.22.5" },
    });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "android", outcome: "blocking" }),
        expect.objectContaining({ owner: "ios", outcome: "proven" }),
        expect.objectContaining({ owner: "desktop", outcome: "blocking" }),
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it("checks actual custom connector intersection schemas rather than treating them as opaque", () => {
    const route = schemaDocument.routes.find((item) => {
      return item.id === "ios.customConnectorByIdContract.get";
    })!;
    const findings = compareRuntimeApiSchemas(
      { ...schemaDocument, routes: [route] },
      {
        ...schemaDocument,
        routes: [
          {
            ...route,
            responses: {
              ...route.responses,
              "200": {
                kind: "json-schema",
                schema: { type: "object", properties: {} },
              },
            },
          },
        ],
      },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(gate({ findings }).passed).toBe(false);
  });

  it("accepts an iOS floor raise to an available version but not a Desktop raise", () => {
    expect(
      gate({ iosAppStoreFloor: { floor: "0.22.6", baseFloor: "0.22.5" } })
        .passed,
    ).toBe(true);
    expect(
      gate({
        desktopFloor: { floor: "0.54.1", baseFloor: "0.54.0" },
        desktopPublishedVersion: "0.54.1",
      }).passed,
    ).toBe(false);
    expect(
      gate({ iosAppStoreFloor: { floor: "0.22.7", baseFloor: "0.22.5" } })
        .passed,
    ).toBe(false);
    expect(
      gate({
        iosAppStoreFloor: { floor: "0.22.6", baseFloor: "0.22.5" },
        iosAppStorePublishedVersion: undefined,
      }).passed,
    ).toBe(false);
  });

  it("accepts only iOS transforms with matching version coverage", () => {
    expect(gate({ iosTransforms: [transform] }).passed).toBe(true);
    expect(
      gate({
        iosTransforms: [
          { ...transform, method: transform.method.toLowerCase() },
        ],
      }).passed,
    ).toBe(false);
    expect(
      gate({ desktopTransforms: [{ ...transform, client: "desktop" }] }).passed,
    ).toBe(false);
    expect(
      gate({ iosTransforms: [{ ...transform, maxVersion: "0.22.5" }] }).passed,
    ).toBe(false);
    expect(
      gate({ iosTransforms: [{ ...transform, maxVersion: "0.22.6" }] }).passed,
    ).toBe(true);
    expect(
      gate({
        iosTransforms: [{ ...transform, maxVersion: "0.22.6" }],
        iosAppStorePublishedVersion: undefined,
      }).passed,
    ).toBe(false);
  });

  it("compares the global iOS 426 envelope and cannot prove errors with a transform", () => {
    const findings = compareRuntimeApiSchemas(
      { ...schemaDocument, routes: [iosRoute] },
      changedResponse("426"),
    );
    expect(
      findings.some((finding) => {
        return finding.responseStatus === 426;
      }),
    ).toBe(true);
    expect(
      gate({ findings, iosTransforms: [{ ...transform, status: 426 }] }).passed,
    ).toBe(false);
    expect(
      gate({
        findings,
        iosAppStoreFloor: { floor: "0.22.6", baseFloor: "0.22.5" },
      }).passed,
    ).toBe(true);
  });

  it("requires a floor proof for old requests and removed routes", () => {
    const baseline = { ...schemaDocument, routes: [iosRoute] };
    const removed = { ...baseline, routes: [] };
    const request: RuntimeApiRouteSnapshot = {
      ...iosRoute,
      request: {
        query: {
          kind: "json-schema",
          schema: {
            type: "object",
            properties: { newField: { type: "string" } },
            required: ["newField"],
          },
        },
      },
    };
    // An added required query field narrows the old empty-object request.
    const oldRequest = {
      ...iosRoute,
      request: {
        query: {
          kind: "json-schema" as const,
          schema: { type: "object", properties: {} },
        },
      },
    };
    for (const findings of [
      compareRuntimeApiSchemas(baseline, removed),
      compareRuntimeApiSchemas(
        { ...baseline, routes: [oldRequest] },
        { ...baseline, routes: [request] },
      ),
    ]) {
      expect(findings.length).toBeGreaterThan(0);
      expect(gate({ findings, iosTransforms: [transform] }).passed).toBe(false);
      expect(
        gate({
          findings,
          iosAppStoreFloor: { floor: "0.22.6", baseFloor: "0.22.5" },
        }).passed,
      ).toBe(true);
    }
  });

  it("checks dictionary values and enum constraints in iOS responses", () => {
    const changes: readonly (readonly [JsonObject, JsonObject])[] = [
      [
        { type: "object", additionalProperties: { type: "boolean" } },
        { type: "object", additionalProperties: { type: "string" } },
      ],
      [{ type: "string", enum: ["ready", "running"] }, { type: "string" }],
    ];
    for (const [before, after] of changes) {
      const previous = {
        ...iosRoute,
        responses: { "200": { kind: "json-schema" as const, schema: before } },
      };
      const current = {
        ...iosRoute,
        responses: { "200": { kind: "json-schema" as const, schema: after } },
      };
      const findings = compareRuntimeApiSchemas(
        { ...schemaDocument, routes: [previous] },
        { ...schemaDocument, routes: [current] },
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(gate({ findings }).passed).toBe(false);
    }
  });

  it("requires proof for a newly required request body", () => {
    const route = schemaDocument.routes.find((item) => {
      return item.id === "ios.platformRealtimeTokenContract.create";
    })!;
    const findings = compareRuntimeApiSchemas(
      { ...schemaDocument, routes: [{ ...route, request: {} }] },
      { ...schemaDocument, routes: [route] },
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "request-body-added" }),
      ]),
    );
    expect(gate({ findings }).passed).toBe(false);
  });

  it("allows an added query default because the old iOS request can still omit it", () => {
    const binding = iosRouteBindings.find((item) => {
      return item.id === iosRoute.id;
    })!;
    const current = buildRuntimeApiSchemaDocument(undefined, [
      {
        ...binding,
        route: {
          ...binding.route,
          query: object({ cursor: string().default("start") }),
        },
      },
    ]);
    const findings = compareRuntimeApiSchemas(
      { ...schemaDocument, routes: [iosRoute] },
      current,
    );
    expect(gate({ findings }).passed).toBe(true);
  });

  it("rejects lowering or removing the iOS floor and unreachable transforms even without findings", () => {
    for (const floor of ["0.22.4", null]) {
      expect(
        gate({ findings: [], iosAppStoreFloor: { floor, baseFloor: "0.22.5" } })
          .errors,
      ).toEqual([expect.objectContaining({ kind: "ios-floor-invalid" })]);
    }
    expect(
      gate({
        findings: [],
        iosTransforms: [{ ...transform, maxVersion: "0.22.4" }],
      }).errors,
    ).toEqual([expect.objectContaining({ kind: "ios-transform-unreachable" })]);
  });

  it("checks iOS policy and writes a machine-readable report through the CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-api-gate-"));
    try {
      const paths = Object.fromEntries(
        ["online", "current", "floor", "base", "report", "receipt"].map(
          (name) => {
            return [name, join(dir, `${name}.json`)];
          },
        ),
      );
      await writeFile(
        paths.online!,
        JSON.stringify({
          ...schemaDocument,
          routes: [iosRoute],
        }),
      );
      await writeFile(paths.current!, JSON.stringify(changedResponse("200")));
      await writeFile(
        paths.floor!,
        JSON.stringify({
          appStoreMinimumSupportedVersion: "0.22.6",
          testFlightMinimumSupportedVersion: "0.22.7",
          reviewCandidate: null,
        }),
      );
      await writeFile(
        paths.base!,
        JSON.stringify({
          appStoreMinimumSupportedVersion: "0.22.5",
          testFlightMinimumSupportedVersion: "0.22.7",
          reviewCandidate: null,
        }),
      );
      await writeFile(
        paths.receipt!,
        JSON.stringify({
          "app-store": {
            version: "0.22.6",
            publishedVersion: "0.22.6",
            build: "42",
            commit: "a".repeat(40),
          },
        }),
      );
      const args = [
        "lint",
        "--against",
        paths.online!,
        "--current",
        paths.current!,
        "--block-owner",
        "ios",
        "--ios-floor",
        paths.floor!,
        "--ios-base-floor",
        paths.base!,
        "--report-out",
        paths.report!,
      ];
      expect(await runRuntimeApiSchemaCli(args)).toBe(1);
      expect(
        await runRuntimeApiSchemaCli([
          ...args,
          "--ios-availability",
          paths.receipt!,
        ]),
      ).toBe(0);
      expect(JSON.parse(await readFile(paths.report!, "utf8"))).toMatchObject({
        passed: true,
        findings: expect.arrayContaining([
          expect.objectContaining({ owner: "ios", outcome: "proven" }),
        ]),
      });
      // With no production snapshot, a beta raise still cannot contract the base iOS API.
      const bootstrap = {
        appStoreMinimumSupportedVersion: null,
        testFlightMinimumSupportedVersion: "0.22.5",
        reviewCandidate: null,
      };
      await writeFile(paths.base!, JSON.stringify(bootstrap));
      await writeFile(
        paths.floor!,
        JSON.stringify({
          ...bootstrap,
          testFlightMinimumSupportedVersion: "0.22.6",
        }),
      );
      await writeFile(
        paths.receipt!,
        JSON.stringify({
          testflight: {
            version: "0.22.6",
            build: "42",
            commit: "a".repeat(40),
          },
        }),
      );
      const missingOnline = args.map((value) => {
        return value === paths.online
          ? join(dir, "missing-production.json")
          : value;
      });
      expect(
        await runRuntimeApiSchemaCli([
          ...missingOnline,
          "--base-schema",
          paths.online!,
          "--ios-availability",
          paths.receipt!,
        ]),
      ).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("iOS distribution policy", () => {
  const upload = { version: "1.2.0", build: "42", commit: "a".repeat(40) };
  const publicBuild = {
    ...upload,
    version: "1.0.0",
    publishedVersion: "1.0.0",
  };
  const publicUpload = { ...upload, publishedVersion: upload.version };
  const policy = {
    appStoreMinimumSupportedVersion: "1.0.0",
    testFlightMinimumSupportedVersion: "1.0.0",
    reviewCandidate: null,
  };
  const launch = { ...policy, appStoreMinimumSupportedVersion: null };
  const legacy = { minimumSupportedVersion: "1.0.0" };

  it("migrates a legacy floor to TestFlight and never treats it as public API proof", () => {
    const migrated = iosGatePolicy(launch, legacy, { testflight: upload });
    expect(migrated.iosAppStoreFloor).toEqual({ floor: null, baseFloor: null });
    expect(gate({ ...migrated, findings: [] }).passed).toBe(true);
    expect(gate(migrated).passed).toBe(false);
    expect(() => {
      return iosGatePolicy(legacy, legacy, {});
    }).toThrow();
  });

  it("TestFlight may advance alone but cannot authorize removing a public response or request", () => {
    const current = {
      ...policy,
      testFlightMinimumSupportedVersion: upload.version,
    };
    const change = iosGatePolicy(current, policy, { testflight: upload });
    expect(gate({ ...change, findings: [] }).passed).toBe(true);
    expect(gate(change).passed).toBe(false);
    expect(
      gate({
        ...change,
        iosTransforms: [{ ...transform, maxVersion: upload.version }],
      }).passed,
    ).toBe(false);
    expect(gate({ ...change, iosTransforms: [transform] }).passed).toBe(true);
    expect(
      iosGatePolicy(current, policy, { "app-store": publicUpload })
        .iosPolicyErrors,
    ).not.toEqual([]);
  });

  it("requires independent evidence for both raises and enforces the relationship without schema findings", () => {
    const raised = {
      ...policy,
      appStoreMinimumSupportedVersion: upload.version,
      testFlightMinimumSupportedVersion: upload.version,
    };
    for (const evidence of [
      {},
      { testflight: upload },
      { "app-store": publicUpload },
    ]) {
      expect(
        gate({ ...iosGatePolicy(raised, policy, evidence), findings: [] })
          .passed,
      ).toBe(false);
    }
    expect(
      gate({
        ...iosGatePolicy(raised, policy, {
          "app-store": publicUpload,
          testflight: upload,
        }),
        findings: [],
      }).passed,
    ).toBe(true);
    for (const beta of [null, "0.99.0"]) {
      expect(
        gate({
          ...iosGatePolicy(
            { ...policy, testFlightMinimumSupportedVersion: beta },
            policy,
            {},
          ),
          findings: [],
        }).passed,
      ).toBe(false);
    }
    expect(
      gate({
        ...iosGatePolicy(
          { ...policy, appStoreMinimumSupportedVersion: null },
          policy,
          {},
        ),
        findings: [],
      }).passed,
    ).toBe(false);
    expect(() => {
      return iosGatePolicy(
        { ...policy, testFlightMinimumSupportedVersion: "1.2.0-beta" },
        policy,
        {},
      );
    }).toThrow();
  });

  it("initializes a verified public floor independently of breaking API changes", () => {
    const activating = iosGatePolicy(policy, launch, {
      "app-store": publicBuild,
    });
    expect(gate({ ...activating, findings: [] }).passed).toBe(true);
    expect(gate({ ...activating, iosTransforms: [transform] }).passed).toBe(
      false,
    );
    expect(
      gate({
        ...iosGatePolicy(policy, launch, {
          testflight: { ...upload, version: publicBuild.version },
        }),
        findings: [],
      }).passed,
    ).toBe(false);
  });

  it("rejects a TestFlight-only version between public releases and uses the latest public build for transforms", () => {
    const unpublished = {
      ...policy,
      appStoreMinimumSupportedVersion: "1.1.0",
      testFlightMinimumSupportedVersion: "1.2.0",
    };
    const receipts = { "app-store": publicUpload, testflight: upload };
    expect(
      gate({ ...iosGatePolicy(unpublished, policy, receipts), findings: [] })
        .passed,
    ).toBe(false);
    const olderPublic = iosGatePolicy(policy, policy, {
      "app-store": { ...publicBuild, publishedVersion: "1.2.0" },
    });
    expect(
      gate({
        ...olderPublic,
        iosTransforms: [{ ...transform, maxVersion: "1.0.0" }],
      }).passed,
    ).toBe(false);
    expect(
      gate({
        ...olderPublic,
        iosTransforms: [{ ...transform, maxVersion: "1.2.0" }],
      }).passed,
    ).toBe(true);
  });

  it("pins version, build and commit for review and protects both the old and new locks", () => {
    const reviewing = { ...policy, reviewCandidate: upload };
    expect(
      iosGatePolicy(reviewing, policy, { testflight: upload }).iosPolicyErrors,
    ).toEqual([]);
    for (const receipt of [
      { ...upload, build: "43" },
      { ...upload, commit: "b".repeat(40) },
      { ...upload, version: "1.2.1" },
    ]) {
      expect(
        iosGatePolicy(reviewing, policy, { testflight: receipt })
          .iosPolicyErrors,
      ).not.toEqual([]);
    }
    expect(iosGatePolicy(reviewing, reviewing, {}).iosPolicyErrors).toEqual([]);
    const newer = { ...upload, version: "1.3.0" };
    for (const reviewCandidate of [null, newer]) {
      const now = {
        ...reviewing,
        reviewCandidate,
        testFlightMinimumSupportedVersion: newer.version,
      };
      expect(
        iosGatePolicy(now, reviewing, {
          testflight: newer,
        }).iosPolicyErrors.join(" "),
      ).toContain("1.2.0");
    }
    expect(
      gate({
        ...iosGatePolicy(reviewing, reviewing, { "app-store": publicBuild }),
        iosTransforms: [{ ...transform, maxVersion: publicBuild.version }],
      }).passed,
    ).toBe(false);
  });
});
