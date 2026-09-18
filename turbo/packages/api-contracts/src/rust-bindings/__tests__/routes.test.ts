import { normalizeRouteBindings, renderRustRoutes } from "../generate";
import { type RustRouteBinding, rustRouteBindings } from "../routes";

const expectedBindings = [
  ...(["resolve", "check"] as const).map((action) => {
    return {
      method: "POST",
      path: `/api/runners/runs/:runId/vnc/${action}`,
      rustModulePath: ["runners", "runs", "by_run_id", "vnc", action],
      rustConstName: action.toUpperCase(),
    };
  }),
  {
    method: "GET",
    path: "/api/runners/runs/:runId/cancellation",
    rustModulePath: ["runners", "runs", "by_run_id", "cancellation"],
    rustConstName: "GET",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/observations",
    rustModulePath: ["runners", "runs", "by_run_id", "ssh", "observations"],
    rustConstName: "OBSERVE",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/resolve",
    rustModulePath: ["runners", "runs", "by_run_id", "ssh", "resolve"],
    rustConstName: "RESOLVE",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/pin",
    rustModulePath: ["runners", "runs", "by_run_id", "ssh", "pin"],
    rustConstName: "PIN",
  },
  {
    method: "POST",
    path: "/api/runners/poll",
    rustModulePath: ["runners", "poll"],
    rustConstName: "POLL",
  },
  {
    method: "POST",
    path: "/api/runners/jobs/:id/release",
    rustModulePath: ["runners", "jobs", "by_id", "release"],
    rustConstName: "RELEASE",
  },
  {
    method: "POST",
    path: "/api/runners/jobs/:id/claim",
    rustModulePath: ["runners", "jobs", "by_id", "claim"],
    rustConstName: "CLAIM",
  },
  {
    method: "GET",
    path: "/api/runners/jobs/:id/pi-handoff/:offset",
    rustModulePath: ["runners", "jobs", "by_id", "pi_handoff", "by_offset"],
    rustConstName: "GET",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/active-inputs/reserve",
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "active_inputs",
      "reserve",
    ],
    rustConstName: "RESERVE",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/active-inputs/deliveries/:deliveryId/receipt",
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "active_inputs",
      "deliveries",
      "by_delivery_id",
      "receipt",
    ],
    rustConstName: "RECEIPT",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/model-provider-failures",
    rustModulePath: ["runners", "runs", "by_run_id", "model_provider_failures"],
    rustConstName: "REPORT",
  },
  {
    method: "POST",
    path: "/api/runners/runs/:runId/connector-runtime/sync",
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "connector_runtime",
      "sync",
    ],
    rustConstName: "SYNC",
  },
  {
    method: "POST",
    path: "/api/runners/builtin-firewalls/resolve",
    rustModulePath: ["runners", "builtin_firewalls", "resolve"],
    rustConstName: "RESOLVE",
  },
  {
    method: "POST",
    path: "/api/runners/heartbeat",
    rustModulePath: ["runners", "heartbeat"],
    rustConstName: "HEARTBEAT",
  },
  {
    method: "POST",
    path: "/api/runners/realtime/token",
    rustModulePath: ["runners", "realtime", "token"],
    rustConstName: "CREATE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/events",
    rustModulePath: ["webhooks", "agent", "events"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/session-output",
    rustModulePath: ["webhooks", "agent", "session_output"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints",
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustConstName: "CREATE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints/prepare-history",
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustConstName: "PREPARE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/complete",
    rustModulePath: ["webhooks", "agent", "complete"],
    rustConstName: "COMPLETE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/heartbeat",
    rustModulePath: ["webhooks", "agent", "heartbeat"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/telemetry",
    rustModulePath: ["webhooks", "agent", "telemetry"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/storages/prepare",
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustConstName: "PREPARE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/storages/commit",
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustConstName: "COMMIT",
  },
] as const;

function validBinding(
  overrides: Partial<RustRouteBinding> = {},
): RustRouteBinding {
  return {
    route: {
      method: "POST",
      path: "/api/webhooks/agent/events",
      summary: "Send an example route",
    },
    rustModulePath: ["webhooks", "agent", "events"],
    rustConstName: "SEND",
    ...overrides,
  };
}

describe("Rust route bindings", () => {
  it("contains exactly the supported Rust route set", () => {
    const actualBindings = rustRouteBindings.map((binding) => {
      return {
        method: binding.route.method,
        path: binding.route.path,
        rustModulePath: [...binding.rustModulePath],
        rustConstName: binding.rustConstName,
      };
    });

    expect(actualBindings).toEqual(expectedBindings);
  });

  it("normalizes the supported registry into unique Rust routes", () => {
    const normalized = normalizeRouteBindings(rustRouteBindings);
    const rustNames = normalized.map((binding) => {
      return [...binding.rustModulePath, binding.rustConstName].join("::");
    });

    expect(normalized).toHaveLength(expectedBindings.length);
    expect(new Set(rustNames).size).toBe(rustNames.length);
  });

  it("renders deterministic Rust route constants", () => {
    const firstRender = renderRustRoutes(rustRouteBindings);
    const secondRender = renderRustRoutes(rustRouteBindings);

    expect(secondRender).toBe(firstRender);
    for (const binding of expectedBindings) {
      expect(firstRender).toContain(
        binding.method === "GET" ? "crate::Method::Get" : "crate::Method::Post",
      );
      expect(firstRender).toContain(`"${binding.path}"`);
    }
  });

  it("renders typed params for routes with path params", () => {
    const rendered = renderRustRoutes(rustRouteBindings);

    expect(rendered).toContain(
      "pub const CLAIM: crate::RouteTemplate = crate::RouteTemplate {",
    );
    expect(rendered).toContain("pub struct Params<'a> {");
    expect(rendered).toContain("pub id: &'a str,");
    expect(rendered).toContain("pub fn route(params: Params<'_>)");
    expect(rendered).toContain("crate::ResolvedRoute::new(CLAIM.method");
    expect(rendered).toContain("crate::route::encode_path_segment(params.id)");
  });

  it("renders Rust docs for route modules, constants, params, and helpers", () => {
    const rendered = renderRustRoutes(rustRouteBindings);

    expect(rendered).toContain(
      "//! Generated Rust route bindings for selected `@okouai/api-contracts` routes.",
    );
    expect(rendered).toContain(
      "/// Generated route bindings under `runners::jobs::by_id::claim`.",
    );
    expect(rendered).toContain("/// Claim a pending job for execution.");
    expect(rendered).toContain(
      "/// Route contract: `POST /api/runners/jobs/:id/claim`.",
    );
    expect(rendered).toContain(
      "/// Path parameters for `POST /api/runners/jobs/:id/claim`.",
    );
    expect(rendered).toContain("/// Value for the `:id` path parameter.");
    expect(rendered).toContain(
      "/// Build the concrete path for `POST /api/runners/jobs/:id/claim`.",
    );
    expect(rendered).toContain(
      "/// Percent-encodes each path parameter as a URL path segment.",
    );
    expect(rendered).toContain(
      "/// Build a resolved route for `POST /api/runners/jobs/:id/claim`.",
    );
  });

  it("renders Rust-safe field names for keyword path params", () => {
    const rendered = renderRustRoutes([
      validBinding({
        route: {
          method: "POST",
          path: "/api/items/:async/:await/:dyn/:gen/:try/:union/:type",
          summary: "Fetch an item by keyword parameters",
        },
        rustModulePath: ["items", "by_keyword"],
        rustConstName: "FETCH",
      }),
    ]);

    expect(rendered).toContain("pub async_: &'a str,");
    expect(rendered).toContain("pub await_: &'a str,");
    expect(rendered).toContain("pub dyn_: &'a str,");
    expect(rendered).toContain("pub gen_: &'a str,");
    expect(rendered).toContain("pub try_: &'a str,");
    expect(rendered).toContain("pub union_: &'a str,");
    expect(rendered).toContain("pub type_: &'a str,");
    expect(rendered).toContain("params.async_");
    expect(rendered).toContain("params.gen_");
    expect(rendered).toContain("params.type_");
  });

  it("renders typed params for routes with multiple path params", () => {
    const rendered = renderRustRoutes([
      validBinding({
        route: {
          method: "POST",
          path: "/api/orgs/:orgId/items/:itemId",
          summary: "Fetch an organization item",
        },
        rustModulePath: ["orgs", "items"],
        rustConstName: "FETCH",
      }),
    ]);

    expect(rendered).toContain('"/api/orgs/{}/items/{}",');
    expect(rendered).toContain("pub org_id: &'a str,");
    expect(rendered).toContain("pub item_id: &'a str,");
    expect(rendered).toContain("encode_path_segment(params.org_id)");
    expect(rendered).toContain("encode_path_segment(params.item_id)");
  });

  it("renders both active-input receipt path parameters", () => {
    const rendered = renderRustRoutes(rustRouteBindings);

    expect(rendered).toContain("pub run_id: &'a str,");
    expect(rendered).toContain("pub delivery_id: &'a str,");
    expect(rendered).toContain(
      "crate::route::encode_path_segment(params.delivery_id)",
    );
  });

  it("escapes Rust format braces in static route segments with path params", () => {
    const rendered = renderRustRoutes([
      validBinding({
        route: {
          method: "POST",
          path: "/api/{version}/items/:id",
          summary: "Fetch an item for a literal version route",
        },
        rustModulePath: ["items", "by_id"],
        rustConstName: "FETCH",
      }),
    ]);

    expect(rendered).toContain('"/api/{{version}}/items/{}",');
  });

  it("fails clearly when a registry entry is malformed", () => {
    const malformedBindings = [
      validBinding({
        route: {
          method: "TRACE",
          path: "/api/webhooks/agent/events",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("unsupported HTTP method");
  });

  it("fails clearly when a route path is invalid", () => {
    const malformedBindings = [
      validBinding({
        route: {
          method: "POST",
          path: "api/webhooks/agent/events",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("route path must start with '/'");
  });

  it("fails clearly when route path param syntax is unsupported", () => {
    const malformedBindings = [
      validBinding({
        route: {
          method: "POST",
          path: "/api/runners/jobs/prefix-:id",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("unsupported route param segment");
  });

  it("fails clearly when a route path param name is invalid", () => {
    const malformedBindings = [
      validBinding({
        route: {
          method: "POST",
          path: "/api/runners/jobs/:1id",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("invalid route param name");
  });

  it("fails clearly when route path params are duplicated", () => {
    const malformedBindings = [
      validBinding({
        route: {
          method: "POST",
          path: "/api/runners/jobs/:id/:id",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("duplicate route param");
  });

  it("fails clearly when path params collide as Rust field names", () => {
    const malformedBindings = [
      validBinding({
        route: {
          method: "POST",
          path: "/api/:fooBar/:foo_bar",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("duplicate Rust route param");
  });

  it("fails clearly when a Rust module segment is invalid", () => {
    const malformedBindings = [
      validBinding({
        rustModulePath: ["webhooks", "agent-events"],
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("invalid Rust module segment");
  });

  it("fails clearly when a Rust const name is invalid", () => {
    const malformedBindings = [
      validBinding({
        rustConstName: "send",
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("invalid Rust const name");
  });

  it("fails clearly when Rust route names are duplicated", () => {
    const malformedBindings = [
      validBinding(),
      validBinding({
        route: {
          method: "POST",
          path: "/api/webhooks/agent/heartbeat",
          summary: "Send an example route",
        },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("duplicate Rust route binding");
  });

  it("fails clearly when method and path route pairs are duplicated", () => {
    const malformedBindings = [
      validBinding(),
      validBinding({
        rustModulePath: ["webhooks", "agent", "heartbeat"],
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("duplicate route binding");
  });

  it("fails clearly when a route summary is invalid", () => {
    for (const route of [
      {
        method: "POST",
        path: "/api/webhooks/agent/events",
      },
      {
        method: "POST",
        path: "/api/webhooks/agent/events",
        summary: "",
      },
    ]) {
      expect(() => {
        normalizeRouteBindings([validBinding({ route })]);
      }).toThrow("missing route summary");
    }
  });

  it("fails clearly when a route summary spans multiple lines", () => {
    expect(() => {
      normalizeRouteBindings([
        validBinding({
          route: {
            method: "POST",
            path: "/api/webhooks/agent/events",
            summary: "Send an example route\nwith extra detail",
          },
        }),
      ]);
    }).toThrow("multiline route summary");
  });
});
