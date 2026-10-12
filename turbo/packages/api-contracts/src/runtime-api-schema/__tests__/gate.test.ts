import type { ClientResponseTransform } from "../../client-transforms/types";
import { compareRuntimeApiSchemas } from "../compat";
import { evaluateRuntimeApiGate, type RuntimeApiGateInput } from "../gate";
import type { RuntimeApiRouteOwner } from "../routes";
import {
  runtimeApiSchemaFormatVersion,
  type RuntimeApiRouteSnapshot,
  type RuntimeApiSchemaDocument,
} from "../schema";

const HOST_PATH = "/api/computer-use/hosts/register";

function route(
  owner: RuntimeApiRouteOwner,
  required: readonly string[],
  overrides: Partial<RuntimeApiRouteSnapshot> = {},
): RuntimeApiRouteSnapshot {
  return {
    id: `${owner}.example`,
    owner,
    method: "POST",
    path: HOST_PATH,
    request: {},
    responses: {
      "200": {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: {
            hostId: { type: "string" },
            ok: { type: "boolean" },
          },
          required: [...required],
        },
      },
    },
    ...overrides,
  };
}

function document(
  ...routes: readonly RuntimeApiRouteSnapshot[]
): RuntimeApiSchemaDocument {
  return {
    schemaFormatVersion: runtimeApiSchemaFormatVersion,
    packageName: "@okouai/api-contracts",
    packageVersion: "0.0.0",
    generatedAt: "2026-10-10T00:00:00.000Z",
    routes,
  };
}

function transform(
  overrides: Partial<ClientResponseTransform> = {},
): ClientResponseTransform {
  return {
    client: "desktop",
    method: "POST",
    path: HOST_PATH,
    status: 200,
    maxVersion: null,
    since: "#38750",
    transform: (body) => {
      return body;
    },
    ...overrides,
  };
}

const production = document(route("desktop", ["hostId", "ok"]));
const removedHostId = document(route("desktop", ["ok"]));

function gate(overrides: Partial<RuntimeApiGateInput> = {}) {
  return evaluateRuntimeApiGate({
    findings: compareRuntimeApiSchemas(production, removedHostId),
    blockingOwners: new Set(["desktop"]),
    desktopFloor: { floor: "0.51.0", baseFloor: "0.51.0" },
    desktopPublishedVersion: "0.52.2",
    desktopTransforms: [],
    ...overrides,
  });
}

function outcomes(result: ReturnType<typeof gate>): readonly string[] {
  return result.findings.map((finding) => {
    return finding.outcome;
  });
}

describe("runtime API Desktop contract gate", () => {
  it("blocks a removed required Desktop response field without proof and names both proofs", () => {
    const result = gate();

    expect(result.passed).toBe(false);
    expect(outcomes(result)).toEqual(["blocking"]);
    const [finding] = result.findings;
    expect(finding?.impact).toContain("Okou Desktop");
    expect(finding?.impact).toContain("decode this response strictly");
    expect(finding?.proofs).toContain(
      "turbo/apps/api/src/lib/desktop-compatibility.json",
    );
    expect(finding?.proofs).toContain(
      "turbo/packages/api-contracts/src/client-transforms/desktop.ts",
    );
  });

  it("accepts a floor raised to the published Desktop version", () => {
    const result = gate({
      desktopFloor: { floor: "0.52.2", baseFloor: "0.51.0" },
    });

    expect(result.passed).toBe(true);
    expect(outcomes(result)).toEqual(["proven"]);
    expect(result.findings[0]?.proofs).toContain(
      "turbo/packages/api-contracts/src/client-transforms/desktop.ts",
    );
  });

  it("accepts a matching transform with a null maxVersion", () => {
    const result = gate({ desktopTransforms: [transform()] });

    expect(result.passed).toBe(true);
    expect(outcomes(result)).toEqual(["proven"]);
  });

  it("accepts a transform whose maxVersion covers the published version", () => {
    const result = gate({
      desktopTransforms: [transform({ maxVersion: "0.52.2" })],
    });

    expect(result.passed).toBe(true);
  });

  it("rejects a transform whose maxVersion is below the published version", () => {
    const result = gate({
      desktopTransforms: [transform({ maxVersion: "0.52.1" })],
    });

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.resolution).toContain(
      "below the published Desktop version 0.52.2",
    );
  });

  it("rejects a transform for another status or path", () => {
    const result = gate({
      desktopTransforms: [
        transform({ status: 201 }),
        transform({ path: "/api/computer-use/hosts/:hostId/stop" }),
      ],
    });

    expect(result.passed).toBe(false);
  });

  it("does not accept a transform for a route-level finding", () => {
    const result = gate({
      findings: compareRuntimeApiSchemas(production, document()),
      desktopTransforms: [transform()],
    });

    expect(
      result.findings.map(({ kind }) => {
        return kind;
      }),
    ).toEqual(["route-removed"]);
    expect(result.passed).toBe(false);
    expect(result.findings[0]?.proofs).toContain(
      "cannot prove a route-level finding",
    );
  });

  it("fails a lowered floor even without findings", () => {
    const result = gate({
      findings: [],
      desktopFloor: { floor: "0.51.0", baseFloor: "0.52.0" },
    });

    expect(result.passed).toBe(false);
    expect(
      result.errors.map(({ kind }) => {
        return kind;
      }),
    ).toEqual(["desktop-floor-invalid"]);
  });

  it("fails a floor that removes the base floor", () => {
    const result = gate({
      findings: [],
      desktopFloor: { floor: null, baseFloor: "0.51.0" },
    });

    expect(result.passed).toBe(false);
  });

  it("fails a floor above the published Desktop version", () => {
    const result = gate({
      desktopFloor: { floor: "0.53.0", baseFloor: "0.51.0" },
    });

    expect(result.passed).toBe(false);
    expect(result.errors[0]?.message).toContain(
      "above the published Desktop version 0.52.2",
    );
    expect(outcomes(result)).toEqual(["blocking"]);
  });

  it("fails a floor raise when the published version oracle is unavailable", () => {
    const result = gate({
      findings: [],
      desktopFloor: { floor: "0.52.2", baseFloor: "0.51.0" },
      desktopPublishedVersion: undefined,
    });

    expect(result.passed).toBe(false);
    expect(result.errors[0]?.message).toContain("RELEASES.json");
  });

  it("does not need the published version oracle when the floor is unchanged", () => {
    const result = gate({ findings: [], desktopPublishedVersion: undefined });

    expect(result.passed).toBe(true);
  });

  it("fails a dead transform even without findings", () => {
    const result = gate({
      findings: [],
      desktopFloor: { floor: "0.52.0", baseFloor: "0.52.0" },
      desktopTransforms: [transform({ maxVersion: "0.51.9" })],
    });

    expect(result.passed).toBe(false);
    expect(
      result.errors.map(({ kind }) => {
        return kind;
      }),
    ).toEqual(["desktop-transform-unreachable"]);
    expect(result.errors[0]?.message).toContain(
      "transform POST /api/computer-use/hosts/register 200 (since #38750) in turbo/packages/api-contracts/src/client-transforms/desktop.ts is unreachable, delete it",
    );
  });

  it("only warns for Runner findings", () => {
    const runnerProduction = document(route("runner", ["hostId", "ok"]));
    const result = gate({
      findings: compareRuntimeApiSchemas(
        runnerProduction,
        document(route("runner", ["ok"])),
      ),
    });

    expect(result.passed).toBe(true);
    expect(outcomes(result)).toEqual(["warning"]);
  });

  it("does not block a finding the base commit already has", () => {
    const result = gate({
      baseFindings: compareRuntimeApiSchemas(production, removedHostId),
    });

    expect(result.passed).toBe(true);
    expect(outcomes(result)).toEqual(["inherited"]);
  });

  it("blocks a new finding next to an inherited one", () => {
    const base = document(route("desktop", ["ok"]));
    const current = document(route("desktop", []));
    const result = gate({
      findings: compareRuntimeApiSchemas(production, current),
      baseFindings: compareRuntimeApiSchemas(production, base),
    });

    expect(outcomes(result)).toEqual(["inherited", "blocking"]);
    expect(result.passed).toBe(false);
  });
});
