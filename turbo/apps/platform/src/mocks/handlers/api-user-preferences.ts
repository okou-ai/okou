import {
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { mockApi } from "../msw-contract.ts";

let mockPreferences: UserPreferencesResponse = {
  timezone: null,
  locale: null,
  translationLanguage: null,
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
  ],
  pinnedAgentIds: [],
  sendMode: "enter",
  cloudBrowserEnabledByDefault: true,
  theme: "system",
  colorTheme: "blue-horizon",
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
    translationLanguage: null,
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
    ],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
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
    };
    return respond(200, mockPreferences);
  }),
  mockApi(userPreferencesContract.get, ({ respond }) => {
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
