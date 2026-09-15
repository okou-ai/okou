import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  personalModelProvidersMainContract,
  personalModelProvidersByTypeContract,
  personalModelProviderAccountsByIdContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

// Mock personal model providers data — empty by default
let mockPersonalModelProviders: ModelProviderResponse[] = [];

export function setMockPersonalModelProviders(
  providers: ModelProviderResponse[],
): void {
  mockPersonalModelProviders = [...providers];
}

/**
 * Reset mock personal model providers to default state
 */
export function resetMockPersonalModelProviders(): void {
  mockPersonalModelProviders = [];
}

export const apiPersonalModelProvidersHandlers = [
  mockApi(
    personalModelProviderAccountsByIdContract.getById,
    ({ params, respond }) => {
      const provider = mockPersonalModelProviders.find(
        (candidate) => candidate.id === params.id,
      );
      return provider
        ? respond(200, provider)
        : respond(404, {
            error: {
              message: "Model provider account not found",
              code: "NOT_FOUND",
            },
          });
    },
  ),
  // GET /api/me/model-providers - List the user's personal model providers
  mockApi(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: mockPersonalModelProviders });
  }),

  // POST /api/me/model-providers - Create or update a personal model provider
  mockApi(personalModelProvidersMainContract.upsert, ({ body, respond }) => {
    const now = nowDate().toISOString();
    const existing = mockPersonalModelProviders.find((p) => {
      return p.type === body.type;
    });
    const created = !existing;

    const provider: ModelProviderResponse = {
      id: existing?.id ?? crypto.randomUUID(),
      type: body.type,
      framework: "claude-code",
      secretName:
        body.type === "claude-code-oauth-token"
          ? "CLAUDE_CODE_OAUTH_TOKEN"
          : "ANTHROPIC_API_KEY",
      authMethod: body.authMethod ?? null,
      secretNames: body.secrets ? Object.keys(body.secrets) : null,
      isDefault: existing?.isDefault ?? false,
      selectedModel: body.selectedModel ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      needsReconnect: false,
      lastRefreshErrorCode: null,
    };

    if (existing) {
      mockPersonalModelProviders = mockPersonalModelProviders.map((p) => {
        return p.type === body.type ? provider : p;
      });
    } else {
      mockPersonalModelProviders.push(provider);
    }

    return respond(created ? 201 : 200, { provider, created });
  }),

  // DELETE /api/me/model-providers/:type - Delete a personal model provider
  mockApi(
    personalModelProvidersByTypeContract.delete,
    ({ params, respond }) => {
      const existing = mockPersonalModelProviders.find((p) => {
        return p.type === params.type;
      });

      if (!existing) {
        return respond(404, {
          error: { message: "Model provider not found", code: "NOT_FOUND" },
        });
      }

      mockPersonalModelProviders = mockPersonalModelProviders.filter((p) => {
        return p.type !== params.type;
      });
      return respond(204);
    },
  ),

  // POST /api/me/model-providers/:type/subscription-reset - Reset Codex usage
  mockApi(
    personalModelProvidersByTypeContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      const existing = mockPersonalModelProviders.find((p) => {
        return p.type === params.type;
      });

      if (!existing || params.type !== "codex-oauth-token") {
        return respond(404, {
          error: { message: "Model provider not found", code: "NOT_FOUND" },
        });
      }

      const resetCredits = existing.subscriptionResetCredits ?? 0;
      if (resetCredits <= 0) {
        return respond(200, { outcome: "noCredit" });
      }

      mockPersonalModelProviders = mockPersonalModelProviders.map((p) => {
        return p.type === params.type
          ? {
              ...p,
              subscriptionResetCredits: resetCredits - 1,
            }
          : p;
      });

      return respond(200, { outcome: "reset" });
    },
  ),

  mockApi(
    personalModelProviderAccountsByIdContract.activate,
    ({ params, respond }) => {
      const selected = mockPersonalModelProviders.find((provider) => {
        return provider.id === params.id;
      });
      if (!selected) {
        return respond(404, {
          error: {
            message: "Model provider account not found",
            code: "NOT_FOUND",
          },
        });
      }
      mockPersonalModelProviders = mockPersonalModelProviders.map(
        (provider) => {
          return provider.type === selected.type
            ? { ...provider, isActive: provider.id === selected.id }
            : provider;
        },
      );
      return respond(200, { ...selected, isActive: true });
    },
  ),

  mockApi(
    personalModelProviderAccountsByIdContract.delete,
    ({ params, respond }) => {
      const selected = mockPersonalModelProviders.find((provider) => {
        return provider.id === params.id;
      });
      if (!selected) {
        return respond(404, {
          error: {
            message: "Model provider account not found",
            code: "NOT_FOUND",
          },
        });
      }
      mockPersonalModelProviders = mockPersonalModelProviders.filter(
        (provider) => {
          return provider.id !== params.id;
        },
      );
      return respond(204);
    },
  ),

  mockApi(
    personalModelProviderAccountsByIdContract.resetFailedRunSubscriptionUsage,
    ({ params, respond }) => {
      const selected = mockPersonalModelProviders.find((provider) => {
        return provider.id === params.id;
      });
      if (!selected || selected.type !== "codex-oauth-token") {
        return respond(404, {
          error: {
            message: "Model provider account not found",
            code: "NOT_FOUND",
          },
        });
      }
      return respond(200, {
        outcome:
          (selected.subscriptionResetCredits ?? 0) > 0 ? "reset" : "noCredit",
      });
    },
  ),
  mockApi(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      const selected = mockPersonalModelProviders.find((provider) => {
        return provider.id === params.id;
      });
      if (!selected || selected.type !== "codex-oauth-token") {
        return respond(404, {
          error: {
            message: "Model provider account not found",
            code: "NOT_FOUND",
          },
        });
      }
      return respond(200, {
        outcome:
          (selected.subscriptionResetCredits ?? 0) > 0 ? "reset" : "noCredit",
      });
    },
  ),
];
