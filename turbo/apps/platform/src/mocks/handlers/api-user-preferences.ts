import {
  DEFAULT_USER_LOCALE,
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
  pinnedAgentIds: [],
  sendMode: "enter",
  cloudBrowserEnabledByDefault: true,
  theme: "system",
  colorTheme: null,
  captureNetworkBodiesRemaining: 0,
  voiceInputModel: null,
};

function normalizePinnedAgentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

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
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
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
      locale: mockPreferences.locale ?? body.locale ?? DEFAULT_USER_LOCALE,
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
    Object.assign(mockPreferences, {
      ...body,
      ...(body.pinnedAgentIds !== undefined && {
        pinnedAgentIds: normalizePinnedAgentIds(body.pinnedAgentIds),
      }),
    });
    return respond(200, mockPreferences);
  }),
];
