import {
  array,
  object,
  string,
  union,
  number,
  tuple,
  enum as zEnum,
} from "zod";
import { renderKotlinFiles, renderKotlinTypes } from "../generate";

describe("selected Kotlin wire generation", () => {
  it("retains explicitly raw envelopes as JSON values inside typed responses", () => {
    const row = object({ id: string(), payload: object({ text: string() }) });
    const source = renderKotlinTypes([
      {
        name: "Page",
        direction: "output",
        schema: object({ rows: array(row), cursor: string() }),
      },
      {
        name: "RawRow",
        direction: "output",
        schema: row,
        representation: "raw-object",
      },
    ]);
    expect(source).toContain("val `rows`: List<Map<String, JsonElement>>");
    expect(source).toContain("val `cursor`: String");
    expect(source).toContain("typealias RawRow = Map<String, JsonElement>");
  });

  it("preserves fixed tuple position types", () => {
    const source = renderKotlinTypes([
      {
        name: "Cursor",
        direction: "input",
        schema: tuple([string(), number().int()]),
      },
    ]);
    expect(source).toContain("val item1: String");
    expect(source).toContain("val item2: Long");
  });

  it("preserves required nullable values, optional input fields and wire enums", () => {
    const source = renderKotlinTypes([
      {
        name: "Fixture",
        direction: "output",
        schema: object({
          timezone: string().nullable(),
          name: string().optional(),
          locale: zEnum(["en-US", "zh-Hant"]),
        }),
      },
    ]);
    expect(source).toContain("val `timezone`: String?,");
    expect(source).not.toContain("val `timezone`: String? = null");
    expect(source).toContain("val `name`: String? = null");
    expect(source).toContain('@SerialName("zh-Hant")');
    expect(source).toContain("enum class FixtureLocale");
  });

  it("fails on unrepresented unions instead of silently weakening a reader", () => {
    expect(() => {
      return renderKotlinTypes([
        {
          name: "Fixture",
          direction: "output",
          schema: object({ value: union([string(), number()]) }),
        },
      ]);
    }).toThrow(/unsupported.*union/u);
  });

  it("represents the consumed empty token body as a serializable singleton", () => {
    const files = renderKotlinFiles();
    expect(files.get("ApiModels.kt")).toContain(
      "@Serializable\ndata object RealtimeTokenRequest",
    );
    expect(files.get("CanonicalApi.kt")).toContain(
      '@POST("/api/realtime/token")',
    );
    expect(files.get("CanonicalApi.kt")).toContain(
      "@Body body: RealtimeTokenRequest",
    );
  });

  it("binds the selected bootstrap methods to generated DTOs", () => {
    const files = renderKotlinFiles();
    expect(files.get("CanonicalApi.kt")).toContain('@GET("/api/org")');
    expect(files.get("CanonicalApi.kt")).toContain(
      '@POST("/api/user-preferences/initialize")',
    );
    expect(files.get("CanonicalApi.kt")).toContain(
      "@Body body: InitializePreferencesRequest",
    );
    expect(files.get("ApiHeaders.kt")).toContain('CLIENT_TYPE = "Android"');
    expect(files.get("ApiModels.kt")).toContain(
      'SerialName("ANDROID_UPDATE_REQUIRED")',
    );
    expect(files.get("CanonicalApi.kt")).toContain(
      "suspend fun `androidUpdates`(): Response<AndroidUpdates>",
    );
  });
});
