import {
  literal,
  never as zNever,
  number,
  object,
  string,
  union,
  unknown as zUnknown,
} from "zod";
import {
  chatThreadEventsContract,
  chatThreadMarkReadContract,
} from "../../contracts/chat-threads";
import { initContract } from "../../contracts/trpc-contract";
import {
  renderKotlinFiles,
  renderKotlinTestFiles,
  renderKotlinTypes,
} from "../generate";
import { kotlinRouteBindings } from "../bindings";

describe("canonical Kotlin history protocol proof", () => {
  it("generates actual canonical history routes and payloads exclusively as test fixtures", () => {
    const files = renderKotlinTestFiles();
    const api = files.get(
      "android/app/src/test/kotlin/ai/okou/android/api/historyfixtures/CanonicalApi.kt",
    )!;
    expect(api).toContain(
      '@GET("/api/chat-threads/{threadId}/event-snapshot")',
    );
    expect(api).toContain('@Path("threadId") `pathThreadId`: String');
    expect(api).toContain("query: RowsQuery");
    expect(api).toContain("query.toQueryParameters()");
    expect(api).toContain("Invalid RowsQuery");
    expect(api).toContain('@POST("/api/chat-threads/{id}/mark-read")');
    expect(api).not.toContain("@Body");
    const wire = JSON.parse(
      files.get(
        "android/app/src/test/resources/api-bindings/chat-history.json",
      )!,
    );
    expect(
      chatThreadEventsContract.rows.responses[200]
        .parse(wire.page)
        .rows.map((row) => {
          return row.seqId;
        }),
    ).toEqual([17, 23, 29, 32, 37]);
    expect(
      chatThreadEventsContract.rows.query.parse(wire.queryWarm).limit,
    ).toBe(12.5);
    expect(
      kotlinRouteBindings.some(({ route }) => {
        return (
          route.path.includes("event-rows") ||
          route === chatThreadMarkReadContract.markRead
        );
      }),
    ).toBe(false);
  });

  it("supports canonical unknown JSON leaves without accepting arbitrary unrepresented schemas", () => {
    const source = renderKotlinTypes([
      {
        name: "Fixture",
        direction: "output",
        schema: object({ opaque: zUnknown().optional() }),
      },
    ]);
    expect(source).toContain(
      "val `opaque`: CanonicalOptionalJson = CanonicalOptionalJson.Absent",
    );
    expect(source).toContain(
      "CanonicalOptionalJson.Present(input.decodeJsonElement())",
    );
    for (const schema of [
      object({ value: literal(1) }),
      object({ impossible: zNever().optional() }),
      union([object({ v: string() }), object({ v: number() })]),
    ]) {
      expect(() => {
        return renderKotlinTypes([
          { name: "Fixture", direction: "output", schema },
        ]);
      }).toThrow();
    }
  });

  it("rejects inconsistent or unrepresented path declarations and preserves canonical no-body markers", () => {
    const response = object({ ok: string() });
    const base = {
      method: "POST",
      path: "/api/fixture/:id",
      body: initContract().noBody(),
      responses: { 200: response },
    };
    const render = (
      route: typeof base & { pathParams?: ReturnType<typeof object> },
    ) => {
      return renderKotlinFiles({
        types: [{ name: "Fixture", schema: response, direction: "output" }],
        routes: [{ name: "read", response: "Fixture", route }],
      });
    };
    expect(
      render({ ...base, pathParams: object({ id: string() }) }).get(
        "CanonicalApi.kt",
      ),
    ).not.toContain("@Body");
    for (const route of [
      base,
      { ...base, pathParams: object({ other: string() }) },
      { ...base, pathParams: object({ id: string().optional() }) },
      { ...base, pathParams: object({ id: number() }) },
      {
        ...base,
        path: "/api/fixture/{id}",
        pathParams: object({ id: string() }),
      },
      { ...base, path: "/api/fixture", pathParams: object({ id: string() }) },
    ])
      expect(() => {
        return render(route);
      }).toThrow(/path/iu);
  });

  it("rejects ambiguous query unions rather than falling back to raw JSON or maps", () => {
    const response = object({ ok: string() });
    expect(() => {
      return renderKotlinFiles({
        types: [{ name: "Fixture", schema: response, direction: "output" }],
        routes: [
          {
            name: "read",
            response: "Fixture",
            route: {
              method: "GET",
              path: "/api/fixture",
              responses: { 200: response },
              query: union([
                object({ cursor: string() }),
                object({ cursor: number() }),
              ]),
            },
          },
        ],
      });
    }).toThrow(/ambiguous/iu);
  });
});
