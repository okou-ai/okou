import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  array,
  coerce,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  tuple,
  union,
  unknown as zUnknown,
  enum as zEnum,
} from "zod";
import { chatThreadsContract } from "../../contracts/chat-threads";
import {
  checkGeneratedKotlin,
  generatedKotlinRelativeDirectory,
  renderKotlinFiles,
  renderKotlinTestFiles,
  renderKotlinTypes,
} from "../generate";

describe("selected Kotlin chat readers", () => {
  it("keeps the committed, compiled readers synchronized with generation", async () => {
    expect(
      await checkGeneratedKotlin(undefined, { testFixtures: true }),
    ).toEqual([]);
  });

  it("renders actual canonical schemas as typed test readers outside main consumption", () => {
    const files = renderKotlinTestFiles();
    expect(
      [...files.keys()].every((path) => {
        return path.startsWith("android/app/src/test/");
      }),
    ).toBe(true);
    const models = files.get(
      "android/app/src/test/kotlin/ai/okou/android/api/fixtures/ApiModels.kt",
    )!;
    expect(models).toContain("sealed interface ChatSnapshot");
    expect(models).toContain("sealed interface ChatEventsEventsItem");
    expect(models).toContain("typealias Agents = List<AgentsItem>");
    expect(models).toContain(
      "typealias IndicatorMap = Map<String, IndicatorMapValue>",
    );
    expect(models).not.toMatch(/\bJsonElement\b/u);
    expect(models).toContain("CanonicalEmptyArray");
    expect(models).toContain('SerialName("ultrafast")');
    expect(models).toContain('SerialName("ultracode")');
    const wire = object({
      events: chatThreadsContract.events.responses[200],
    }).parse(
      JSON.parse(
        files.get(
          "android/app/src/test/resources/api-bindings/chat-list.json",
        )!,
      ),
    );
    expect(
      wire.events.events.map((event) => {
        return event.seqId;
      }),
    ).toEqual([17, 23]);
  });

  it("merges only string-enum unions, preserving null and optional distinctions", () => {
    const source = renderKotlinTypes([
      {
        name: "Fixture",
        direction: "output",
        schema: object({
          required: union([
            zEnum(["low", "high"]),
            zEnum(["high", "extra"]),
          ]).nullable(),
          optional: record(string(), array(string())).optional(),
        }),
      },
    ]);
    expect(source.match(/SerialName\("high"\)/gu)).toHaveLength(1);
    expect(source).toContain("val `required`: FixtureRequired?,");
    expect(source).toContain(
      "val `optional`: Map<String, List<String>>? = null,",
    );
  });

  it.each([
    union([object({ value: string() }), object({ value: number() })]),
    union([string(), number()]),
    union([
      object({ kind: zEnum(["a", "b"]) }),
      object({ kind: literal("b") }),
    ]),
    object({ value: record(string(), zUnknown()) }),
    object({ value: tuple([string(), number()]) }),
    object({ value: zEnum(["a-b", "a_b"]) }),
  ])(
    "rejects ambiguous or unrepresented shapes instead of weakening them",
    (schema) => {
      expect(() => {
        return renderKotlinTypes([
          { name: "Fixture", direction: "output", schema },
        ]);
      }).toThrow();
    },
  );

  it("renders disjoint discriminated objects without inventing wire wrapper fields", () => {
    const source = renderKotlinTypes([
      {
        name: "Fixture",
        direction: "output",
        schema: discriminatedUnion("kind", [
          object({ kind: literal("one"), value: string() }),
          object({ kind: literal("two"), value: number() }),
        ]),
      },
    ]);
    expect(source).toContain("val matches = listOf(");
    expect(source).toContain("matches.count { it } != 1");
    expect(source).toContain(
      "encoder.encodeSerializableValue(FixtureVariant1.serializer(), value)",
    );
    expect(source).not.toContain("PolymorphicSerializer");
  });

  it("binds canonical optional coerced scalar queries with distinct argument names", () => {
    const response = object({ value: string() });
    const files = renderKotlinFiles({
      types: [{ name: "Fixture", schema: response, direction: "output" }],
      routes: [
        {
          name: "read",
          response: "Fixture",
          route: {
            method: "GET",
            path: "/api/fixture",
            query: object({
              sinceSeqId: coerce.number().int().positive().optional(),
              token: string().optional(),
            }),
            responses: { 200: response },
          },
        },
      ],
    });
    expect(files.get("CanonicalApi.kt")).toContain(
      '@Query("sinceSeqId") `querySinceSeqId`: Long? = null',
    );
    expect(files.get("CanonicalApi.kt")).toContain(
      '@Query("token") `queryToken`: String? = null',
    );
  });

  it("rejects unsupported queries, route/DTO mismatches and unsafe packages before output", () => {
    for (const query of [
      object({ values: array(string()) }),
      union([object({ first: string() }), object({ second: number() })]),
      object({ limit: number().default(50) }),
      object({ cursor: string(), Cursor: string() }),
    ]) {
      const response = object({ value: string() });
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
                query,
                responses: { 200: response },
              },
            },
          ],
        });
      }).toThrow(/query/iu);
    }
    expect(() => {
      return renderKotlinFiles({
        types: [
          {
            name: "Fixture",
            schema: object({ events: array(string()) }),
            direction: "output",
          },
        ],
        routes: [
          {
            name: "read",
            response: "Fixture",
            route: chatThreadsContract.events,
          },
        ],
      });
    }).toThrow(/does not match/u);
    expect(() => {
      return renderKotlinFiles({ packageName: "unsafe; import other" });
    }).toThrow(/package/u);
  });

  it("checks test reader/resource drift without treating fixtures as installed readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "kotlin-reader-drift-"));
    try {
      const files = new Map([
        ...[...renderKotlinFiles()].map(([file, source]) => {
          return [
            join(generatedKotlinRelativeDirectory, file),
            source,
          ] as const;
        }),
        ...renderKotlinTestFiles(),
      ]);
      for (const [file, source] of files) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), source);
      }
      expect(await checkGeneratedKotlin(root, { testFixtures: true })).toEqual(
        [],
      );
      const path = join(
        root,
        "android/app/src/test/kotlin/ai/okou/android/api/fixtures/ApiModels.kt",
      );
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          "sealed interface ChatSnapshot",
          "sealed interface ChangedSnapshot",
        ),
      );
      expect(await checkGeneratedKotlin(root)).toEqual([]);
      expect(await checkGeneratedKotlin(root, { testFixtures: true })).toEqual([
        expect.stringContaining("src/test/kotlin"),
      ]);
      await writeFile(
        path,
        files.get(
          "android/app/src/test/kotlin/ai/okou/android/api/fixtures/ApiModels.kt",
        )!,
      );
      await writeFile(
        join(
          root,
          "android/app/src/test/resources/api-bindings/chat-list.json",
        ),
        "{}",
      );
      expect(await checkGeneratedKotlin(root, { testFixtures: true })).toEqual([
        expect.stringContaining("chat-list.json"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
