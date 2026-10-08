import {
  type UserModelPreferenceResponse,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { withModelReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

let mockUserModelPreference: UserModelPreferenceResponse = {
  selectedModel: null,
  serviceTier: null,
  modelSettings: {},
  selectedImageModel: null,
  updatedAt: null,
};

export function resetMockUserModelPreference(): void {
  mockUserModelPreference = {
    selectedModel: null,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  };
}

export function setMockUserModelPreference(
  preference: UserModelPreferenceResponse,
): void {
  mockUserModelPreference = preference;
}

export const apiUserModelPreferenceHandlers = [
  mockApi(userModelPreferenceContract.get, ({ respond }) => {
    return respond(200, mockUserModelPreference);
  }),
  mockApi(userModelPreferenceContract.update, ({ body, respond }) => {
    mockUserModelPreference = {
      selectedModel: body.selectedModel,
      serviceTier: body.serviceTier,
      modelSettings:
        body.modelSettingsPatch === undefined
          ? mockUserModelPreference.modelSettings
          : withModelReasoningEffort(
              mockUserModelPreference.modelSettings,
              body.modelSettingsPatch,
            ),
      selectedImageModel:
        "selectedImageModel" in body
          ? (body.selectedImageModel ?? null)
          : mockUserModelPreference.selectedImageModel,
      updatedAt: nowDate().toISOString(),
    };
    return respond(200, mockUserModelPreference);
  }),
];
