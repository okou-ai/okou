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
    iosFloor: { floor: "0.22.5", baseFloor: "0.22.5" },
    iosPublishedVersion: "0.22.6",
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
    ).toEqual(["desktop", "ios"]);
    const findings = compareRuntimeApiSchemas(
      { ...schemaDocument, routes },
      { ...schemaDocument, routes: [] },
    );
    const result = gate({
      findings,
      iosFloor: { floor: "0.22.6", baseFloor: "0.22.5" },
    });
    expect(result.findings).toEqual(
      expect.arrayContaining([
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
      gate({ iosFloor: { floor: "0.22.6", baseFloor: "0.22.5" } }).passed,
    ).toBe(true);
    expect(
      gate({
        desktopFloor: { floor: "0.54.1", baseFloor: "0.54.0" },
        desktopPublishedVersion: "0.54.1",
      }).passed,
    ).toBe(false);
    expect(
      gate({ iosFloor: { floor: "0.22.7", baseFloor: "0.22.5" } }).passed,
    ).toBe(false);
    expect(
      gate({
        iosFloor: { floor: "0.22.6", baseFloor: "0.22.5" },
        iosPublishedVersion: undefined,
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
        iosPublishedVersion: undefined,
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
      gate({ findings, iosFloor: { floor: "0.22.6", baseFloor: "0.22.5" } })
        .passed,
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
        gate({ findings, iosFloor: { floor: "0.22.6", baseFloor: "0.22.5" } })
          .passed,
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
        gate({ findings: [], iosFloor: { floor, baseFloor: "0.22.5" } }).errors,
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
        ["online", "current", "floor", "base", "report"].map((name) => {
          return [name, join(dir, `${name}.json`)];
        }),
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
        JSON.stringify({ minimumSupportedVersion: "0.22.6" }),
      );
      await writeFile(
        paths.base!,
        JSON.stringify({ minimumSupportedVersion: "0.22.5" }),
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
          "--ios-published-version",
          "0.22.6",
        ]),
      ).toBe(0);
      expect(JSON.parse(await readFile(paths.report!, "utf8"))).toMatchObject({
        passed: true,
        findings: expect.arrayContaining([
          expect.objectContaining({ owner: "ios", outcome: "proven" }),
        ]),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
