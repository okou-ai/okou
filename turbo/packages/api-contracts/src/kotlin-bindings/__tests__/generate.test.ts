import { object, string, union, number, enum as zEnum } from "zod";
import { renderKotlinFiles, renderKotlinTypes } from "../generate";

describe("selected Kotlin wire generation", () => {
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
  });
});
