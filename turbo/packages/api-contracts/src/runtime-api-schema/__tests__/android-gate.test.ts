import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRuntimeApiSchemaDocument,
  renderRuntimeApiSchemaDocument,
  type RuntimeApiSchemaDocument,
} from "../schema";
import { compareRuntimeApiSchemas } from "../compat";
import { evaluateRuntimeApiGate, type RuntimeApiGateInput } from "../gate";
import { runRuntimeApiSchemaCli } from "../command";

const document = buildRuntimeApiSchemaDocument();
const android = document.routes.find((route) => {
  return route.id === "android.organization";
})!;
const online = { ...document, routes: [android] };
function changed(status = "200"): RuntimeApiSchemaDocument {
  return {
    ...document,
    routes: [
      {
        ...android,
        responses: {
          ...android.responses,
          [status]: {
            kind: "json-schema",
            schema: { type: "object", properties: {}, required: [] },
          },
        },
      },
    ],
  };
}
function gate(options: Partial<RuntimeApiGateInput> = {}) {
  return evaluateRuntimeApiGate({
    findings: compareRuntimeApiSchemas(online, changed()),
    blockingOwners: new Set(["desktop", "ios", "android"]),
    desktopTransforms: [],
    androidTransforms: [],
    androidFloor: { floor: null, baseFloor: null },
    ...options,
  });
}

describe("Android installed-client schema gate", () => {
  it("blocks real response and global 426 changes with independent Android proofs", () => {
    for (const status of ["200", "426"]) {
      const result = gate({
        findings: compareRuntimeApiSchemas(online, changed(status)),
      });
      expect(result.passed).toBe(false);
      expect(
        result.findings.every((finding) => {
          return finding.owner === "android" && finding.outcome === "blocking";
        }),
      ).toBe(true);
      expect(result.findings[0]?.proofs).toContain(
        "android-client-compatibility.json",
      );
      expect(result.findings[0]?.proofs).toContain(
        "client-transforms/android.ts",
      );
    }
  });

  it("requires actual availability for a floor raise and forbids lowering/removing it without findings", () => {
    expect(
      gate({ androidFloor: { floor: "0.2.0", baseFloor: null } }).passed,
    ).toBe(false);
    expect(
      gate({
        androidFloor: { floor: "0.2.0", baseFloor: null },
        androidPublishedVersion: "0.1.0",
      }).passed,
    ).toBe(false);
    expect(
      gate({
        androidFloor: { floor: "0.2.0", baseFloor: null },
        androidPublishedVersion: "0.2.0",
      }).passed,
    ).toBe(true);
    for (const floor of ["0.1.0", null]) {
      expect(
        gate({ findings: [], androidFloor: { floor, baseFloor: "0.2.0" } })
          .passed,
      ).toBe(false);
    }
  });

  it("does not accept an Android transform as proof for iOS or for an error body", () => {
    const shared = document.routes.filter((route) => {
      return route.path === android.path && route.method === android.method;
    });
    const modified = {
      ...document,
      routes: shared.map((route) => {
        return {
          ...route,
          responses: changed().routes[0]!.responses,
        };
      }),
    };
    const result = gate({
      findings: compareRuntimeApiSchemas(
        { ...document, routes: shared },
        modified,
      ),
      androidTransforms: [
        {
          client: "android",
          method: android.method,
          path: android.path,
          status: 200,
          maxVersion: null,
          since: "#1",
          transform: (body) => {
            return body;
          },
        },
      ],
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ owner: "android", outcome: "proven" }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ owner: "ios", outcome: "blocking" }),
    );
    const errors = gate({
      findings: compareRuntimeApiSchemas(online, changed("426")),
      androidTransforms: [
        {
          client: "android",
          method: android.method,
          path: android.path,
          status: 426,
          maxVersion: null,
          since: "#1",
          transform: (body) => {
            return body;
          },
        },
      ],
    });
    expect(errors.passed).toBe(false);
  });

  it("checks Android policy and baseline registration through the actual CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "android-gate-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const schema = join(root, "production.json"),
        floor = join(root, "floor.json"),
        baseFloor = join(root, "base-floor.json"),
        report = join(root, "report.json");
      await writeFile(
        schema,
        renderRuntimeApiSchemaDocument({
          ...document,
          routes: document.routes.filter((route) => {
            return route.owner !== "android";
          }),
        }),
      );
      await writeFile(floor, '{"minimumSupportedVersion":null}');
      await writeFile(baseFloor, '{"minimumSupportedVersion":null}');
      const args = [
        "lint",
        "--against",
        schema,
        "--block-owner",
        "android",
        "--android-floor",
        floor,
        "--android-base-floor",
        baseFloor,
        "--report-out",
        report,
      ];
      expect(await runRuntimeApiSchemaCli(args)).toBe(0);
      expect(warn.mock.calls.flat().join("\n")).toContain(
        "no Android contract baseline",
      );
      await writeFile(schema, renderRuntimeApiSchemaDocument(online));
      const candidate = join(root, "candidate.json");
      await writeFile(candidate, renderRuntimeApiSchemaDocument(changed()));
      expect(
        await runRuntimeApiSchemaCli([...args, "--current", candidate]),
      ).toBe(1);
      expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
        passed: false,
      });
      await writeFile(floor, '{"minimumSupportedVersion":"0.2.0"}');
      const raised = [...args, "--current", candidate];
      expect(await runRuntimeApiSchemaCli(raised)).toBe(1);
      expect(
        await runRuntimeApiSchemaCli([
          ...raised,
          "--android-published-version",
          "0.1.0",
        ]),
      ).toBe(1);
      expect(
        await runRuntimeApiSchemaCli([
          ...raised,
          "--android-published-version",
          "0.2.0",
        ]),
      ).toBe(0);
      expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
        passed: true,
      });
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
