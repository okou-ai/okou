import { z } from "zod";
import {
  normalizeDecodePathBindings,
  renderRustDecodePaths,
  type DecodePathNode,
} from "../generate";
import {
  type RustDecodePathBinding,
  rustDecodePathBindings,
} from "../decode-paths";

const expectedBindings = [
  "runners::builtin_firewalls::resolve::RESPONSE",
  "runners::jobs::by_id::claim::RESPONSE",
  "runners::poll::RESPONSE",
  "runners::realtime::token::RESPONSE",
  "runners::runs::by_run_id::active_inputs::deliveries::by_delivery_id::receipt::RESPONSE",
  "runners::runs::by_run_id::active_inputs::reserve::RESPONSE",
  "runners::runs::by_run_id::cancellation::RESPONSE",
  "runners::runs::by_run_id::connector_runtime::sync::RESPONSE",
] as const;

function binding(
  schema: z.ZodType,
  overrides: Partial<RustDecodePathBinding> = {},
): RustDecodePathBinding {
  return {
    schema,
    rustModulePath: ["runners", "example"],
    rustConstName: "RESPONSE",
    rustDoc: ["Example response decode-path schema."],
    ...overrides,
  };
}

function normalizedNode(schema: z.ZodType): DecodePathNode {
  const normalized = normalizeDecodePathBindings([binding(schema)]).at(0);
  if (!normalized) {
    throw new Error("Expected one normalized decode-path binding");
  }
  return normalized.node;
}

describe("Rust decode-path bindings", () => {
  it("contains exactly the responses decoded by the generic runner client", () => {
    const actual = normalizeDecodePathBindings(rustDecodePathBindings).map(
      (entry) => {
        return [...entry.rustModulePath, entry.rustConstName].join("::");
      },
    );

    expect(actual).toEqual(expectedBindings);
  });

  it("renders deterministic metadata for current claim and non-claim fields", () => {
    const first = renderRustDecodePaths(rustDecodePathBindings);
    const second = renderRustDecodePaths(rustDecodePathBindings);

    expect(second).toBe(first);
    expect(first).toContain('DecodePathField::new("providerId"');
    expect(first).toContain('DecodePathField::new("apiKeyEnv"');
    expect(first).toContain('DecodePathField::new("networkPolicyRefreshes"');
    expect(first).toContain('DecodePathField::new("httpHeaders"');
    expect(first).toContain('DecodePathField::new("modelCatalog"');
    expect(first).toContain('DecodePathField::new("catalogDigest"');
    expect(first).toContain('DecodePathField::new("keyName"');
    expect(first).toContain('DecodePathField::new("outcome"');
  });

  it("normalizes fixed objects, arrays, nullable objects, and unions", () => {
    const node = normalizedNode(
      z.object({
        entries: z.array(
          z.union([
            z.object({ kind: z.literal("one"), value: z.string() }),
            z.object({ kind: z.literal("two"), reason: z.string() }),
          ]),
        ),
        nested: z.object({ enabled: z.boolean() }).nullable(),
      }),
    );

    expect(node).toEqual({
      kind: "object",
      fields: [
        {
          name: "entries",
          node: {
            kind: "sequence",
            item: {
              kind: "object",
              fields: [
                { name: "kind", node: { kind: "leaf" } },
                { name: "reason", node: { kind: "leaf" } },
                { name: "value", node: { kind: "leaf" } },
              ],
            },
          },
        },
        {
          name: "nested",
          node: {
            kind: "object",
            fields: [{ name: "enabled", node: { kind: "leaf" } }],
          },
        },
      ],
    });
  });

  it("retains typed map value fields after the dynamic key boundary", () => {
    const node = normalizedNode(
      z.object({
        policies: z.record(
          z.string(),
          z.object({ allow: z.array(z.string()), mode: z.string() }),
        ),
      }),
    );

    expect(node).toEqual({
      kind: "object",
      fields: [
        {
          name: "policies",
          node: {
            kind: "dynamic-map",
            value: {
              kind: "object",
              fields: [
                {
                  name: "allow",
                  node: { kind: "sequence", item: { kind: "leaf" } },
                },
                { name: "mode", node: { kind: "leaf" } },
              ],
            },
          },
        },
      ],
    });
  });

  it("keeps opaque map values without printable descendants", () => {
    const node = normalizedNode(
      z.object({ catalog: z.record(z.string(), z.unknown()) }),
    );

    expect(node).toEqual({
      kind: "object",
      fields: [
        {
          name: "catalog",
          node: { kind: "dynamic-map", value: { kind: "leaf" } },
        },
      ],
    });
  });

  it("rejects duplicate generated roots", () => {
    expect(() => {
      normalizeDecodePathBindings([
        binding(z.object({ first: z.string() })),
        binding(z.object({ second: z.string() })),
      ]);
    }).toThrow("duplicate Rust decode-path binding");
  });

  it("rejects permissive and incompatible traversable shapes", () => {
    expect(() => {
      normalizedNode(z.object({ fixed: z.string() }).passthrough());
    }).toThrow("mixes fixed fields with dynamic decode-path fields");

    expect(() => {
      normalizedNode(
        z.union([
          z.object({ fixed: z.string() }),
          z.record(z.string(), z.string()),
        ]),
      );
    }).toThrow("mixes incompatible decode-path shapes");
  });
});
