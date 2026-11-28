import {
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { mockApi } from "../msw-contract.ts";

let mockPreferences: UserPreferencesResponse = {
  timezone: null,
  locale: null,
  supportedLocales: [
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
  ],
  sendMode: "enter",
  cloudBrowserEnabledByDefault: true,
  chatResourcesEnabledByDefault: false,
  forYouCoverId: null,
  theme: "system",
  colorTheme: null,
  presentationFormat: null,
  captureNetworkBodiesRemaining: 0,
  memoryInitialized: true,
};

export function resetMockUserPreferences(): void {
  mockPreferences = {
    timezone: null,
    locale: null,
    supportedLocales: [
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
    ],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    presentationFormat: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}

export function setMockUserPreferences(
  overrides: Partial<UserPreferencesResponse>,
): void {
  mockPreferences = { ...mockPreferences, ...overrides };
}

export const apiUserPreferencesHandlers = [
  mockApi(userPreferencesContract.initialize, ({ body, respond }) => {
    mockPreferences = {
      ...mockPreferences,
      timezone: mockPreferences.timezone ?? body.timezone ?? null,
      locale: mockPreferences.locale ?? body.locale,
      memoryInitialized: true,
    };
    return respond(200, mockPreferences);
  }),
  mockApi(userPreferencesContract.get, ({ respond }) => {
    if (mockPreferences.timezone === null || mockPreferences.locale === null) {
      return respond(409, {
        error: {
          code: "USER_PREFERENCES_UNINITIALIZED",
          message: "User preferences require timezone or locale initialization",
        },
      });
    }
    return respond(200, mockPreferences);
  }),
  mockApi(userPreferencesContract.update, ({ body, respond }) => {
    Object.assign(mockPreferences, body);
    return respond(200, mockPreferences);
  }),
];
