import { describe, expect, it } from "vitest";

import {
  SUPPORTED_USER_LOCALES,
  updateUserPreferencesRequestSchema,
  userLocaleSchema,
  userPreferencesResponseSchema,
} from "./user-preferences";

describe("user preferences contract", () => {
  const legacyPreferences = {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };

  it("accepts the flag-off response without adding a presentation format field", () => {
    const parsed = userPreferencesResponseSchema.parse(legacyPreferences);
    expect(parsed).toStrictEqual(legacyPreferences);
    expect(parsed).not.toHaveProperty("presentationFormat");
  });

  it.each([null, "html", "pptx"] as const)(
    "accepts an enabled presentation format of %s",
    (presentationFormat) => {
      const preferences = { ...legacyPreferences, presentationFormat };
      expect(userPreferencesResponseSchema.parse(preferences)).toStrictEqual(
        preferences,
      );
    },
  );

  it("rejects unsupported presentation formats", () => {
    expect(
      userPreferencesResponseSchema.safeParse({
        ...legacyPreferences,
        presentationFormat: "pdf",
      }).success,
    ).toBe(false);
  });

  it("keeps old updates and explicit format clears distinct from an empty update", () => {
    expect(
      updateUserPreferencesRequestSchema.parse({ theme: "light" }),
    ).toStrictEqual({
      theme: "light",
    });
    expect(
      updateUserPreferencesRequestSchema.parse({ presentationFormat: null }),
    ).toStrictEqual({ presentationFormat: null });
    expect(updateUserPreferencesRequestSchema.safeParse({}).success).toBe(
      false,
    );
  });

  it("accepts Indonesian as a user locale", () => {
    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "id-ID",
      supportedLocales: ["en-US", "pt-BR", "id-ID"],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      chatResourcesEnabledByDefault: true,
      theme: null,
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
      memoryInitialized: true,
    });

    expect(preferences.locale).toBe("id-ID");
  });

  it("accepts the canonical Japanese locale", () => {
    expect(userLocaleSchema.parse("ja-JP")).toBe("ja-JP");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "ja-JP",
        supportedLocales: ["en-US", "pt-BR", "ja-JP"],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        chatResourcesEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
        memoryInitialized: true,
      }),
    ).toMatchObject({
      locale: "ja-JP",
      supportedLocales: ["en-US", "pt-BR", "ja-JP"],
    });
  });

  it("accepts the canonical Korean locale", () => {
    expect(userLocaleSchema.parse("ko-KR")).toBe("ko-KR");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "ko-KR",
        supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        chatResourcesEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
        memoryInitialized: true,
      }),
    ).toMatchObject({
      locale: "ko-KR",
      supportedLocales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
    });
  });

  it("accepts the canonical Spanish locale", () => {
    expect(userLocaleSchema.parse("es-ES")).toBe("es-ES");
    expect(
      userPreferencesResponseSchema.parse({
        timezone: null,
        locale: "es-ES",
        supportedLocales: ["en-US", "pt-BR", "ja-JP", "es-ES"],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        chatResourcesEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
        memoryInitialized: true,
      }),
    ).toMatchObject({
      locale: "es-ES",
      supportedLocales: ["en-US", "pt-BR", "ja-JP", "es-ES"],
    });
  });

  it("accepts Italian in preference requests and supported locale responses", () => {
    expect(
      updateUserPreferencesRequestSchema.parse({ locale: "it-IT" }),
    ).toStrictEqual({ locale: "it-IT" });

    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "it-IT",
      supportedLocales: ["en-US", "it-IT"],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      chatResourcesEnabledByDefault: true,
      theme: null,
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
      memoryInitialized: true,
    });

    expect(preferences.locale).toBe("it-IT");
    expect(preferences.supportedLocales).toStrictEqual(["en-US", "it-IT"]);
  });

  it("accepts every current user locale in an API response", () => {
    expect(SUPPORTED_USER_LOCALES).toStrictEqual([
      "en-US",
      "pt-BR",
      "ja-JP",
      "ko-KR",
      "id-ID",
      "de-DE",
      "es-ES",
      "it-IT",
      "fr-FR",
      "hi-IN",
      "zh-Hans",
      "zh-Hant",
    ]);

    const preferences = userPreferencesResponseSchema.parse({
      timezone: null,
      locale: "zh-Hant",
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      chatResourcesEnabledByDefault: true,
      theme: null,
      colorTheme: null,
      captureNetworkBodiesRemaining: 0,
      memoryInitialized: true,
    });

    expect(preferences.locale).toBe("zh-Hant");
    expect(preferences.supportedLocales).toStrictEqual([
      ...SUPPORTED_USER_LOCALES,
    ]);
  });
});
