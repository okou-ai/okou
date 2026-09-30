import { command, computed, state } from "ccstate";
import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import type {
  ModelProviderConnectionResponse,
  ModelProviderSurfaceProtocol,
} from "@okouai/api-contracts/contracts/model-provider-gateways";

import {
  modelCatalog$,
  type ModelCatalog,
} from "../../external/model-catalog.ts";
import {
  createModelProviderConnection$,
  updateModelProviderConnection$,
} from "../../external/model-provider-connections.ts";
import { jsonParseOr, resetSignal } from "../../utils.ts";

export type ModelProviderConnectionTemplate =
  | "custom"
  | "vercel"
  | "openrouter"
  | "fireworks";

interface SurfaceDraft {
  readonly enabled: boolean;
  readonly apiBaseUrl: string;
  readonly authHeaderName: string;
  readonly authHeaderTemplate: string;
  readonly modelMappings: string;
}

interface ConnectionDraft {
  readonly open: boolean;
  readonly editingId: string | null;
  readonly displayName: string;
  readonly secret: string;
  readonly messages: SurfaceDraft;
  readonly responses: SurfaceDraft;
  readonly error:
    | "invalidMappings"
    | "missingProtocol"
    | "missingSecret"
    | null;
}

type SurfaceField = Exclude<keyof SurfaceDraft, "enabled">;

/** Prefill mappings from the catalog's active routes for this provider. */
function mappingsFor(
  type: ModelProviderType,
  catalog: ModelCatalog | null,
): string {
  return JSON.stringify(
    Object.fromEntries(
      (catalog?.activeModels ?? []).flatMap((entry) => {
        const route = catalog?.routes(entry.model, { providerType: type })[0];
        return route ? [[entry.model, route.upstreamModel]] : [];
      }),
    ),
    null,
    2,
  );
}

function emptySurface(): SurfaceDraft {
  return {
    enabled: false,
    apiBaseUrl: "",
    authHeaderName: "Authorization",
    authHeaderTemplate: "Bearer {{secret}}",
    modelMappings: "{}",
  };
}

function templateDraft(
  template: ModelProviderConnectionTemplate,
  catalog: ModelCatalog | null = null,
): ConnectionDraft {
  const base = {
    open: true,
    editingId: null,
    secret: "",
    error: null,
  } as const;
  if (template === "vercel") {
    return {
      ...base,
      displayName: "Vercel AI Gateway",
      messages: {
        ...emptySurface(),
        enabled: true,
        apiBaseUrl: "https://ai-gateway.vercel.sh",
        modelMappings: mappingsFor("vercel-ai-gateway", catalog),
      },
      responses: {
        ...emptySurface(),
        enabled: true,
        apiBaseUrl: "https://ai-gateway.vercel.sh/v1",
        modelMappings: mappingsFor("vercel-ai-gateway-codex", catalog),
      },
    };
  }
  if (template === "openrouter") {
    return {
      ...base,
      displayName: "OpenRouter",
      messages: {
        ...emptySurface(),
        enabled: true,
        apiBaseUrl: "https://openrouter.ai/api",
        modelMappings: mappingsFor("openrouter-api-key", catalog),
      },
      responses: {
        ...emptySurface(),
        enabled: true,
        apiBaseUrl: "https://openrouter.ai/api/v1",
        modelMappings: mappingsFor("openrouter-codex", catalog),
      },
    };
  }
  if (template === "fireworks") {
    return {
      ...base,
      displayName: "Fireworks AI",
      messages: {
        ...emptySurface(),
        enabled: true,
        apiBaseUrl: "https://api.fireworks.ai/inference",
      },
      responses: {
        ...emptySurface(),
        enabled: true,
        apiBaseUrl: "https://api.fireworks.ai/inference/v1",
      },
    };
  }
  return {
    ...base,
    displayName: "",
    messages: { ...emptySurface(), enabled: true },
    responses: emptySurface(),
  };
}

function closedDraft(): ConnectionDraft {
  return {
    ...templateDraft("custom"),
    open: false,
  };
}

const internalConnectionDraft$ = state<ConnectionDraft>(closedDraft());
const internalConnectionDialogSignal$ = state<AbortSignal | null>(null);
const resetConnectionDialogSignal$ = resetSignal();

export { internalConnectionDialogSignal$ as modelProviderConnectionDialogSignal$ };

const internalPendingDeleteConnection$ =
  state<ModelProviderConnectionResponse | null>(null);

export const modelProviderConnectionDraft$ = computed((get) => {
  return get(internalConnectionDraft$);
});

export const pendingDeleteModelProviderConnection$ = computed((get) => {
  return get(internalPendingDeleteConnection$);
});

const resetConnectionDialogState$ = command(({ set }) => {
  set(internalConnectionDialogSignal$, null);
  set(internalConnectionDraft$, closedDraft());
});

const openConnectionDialog$ = command(
  ({ set }, draft: ConnectionDraft, settingsDialogSignal: AbortSignal) => {
    settingsDialogSignal.throwIfAborted();
    const signal = set(resetConnectionDialogSignal$, settingsDialogSignal);
    signal.addEventListener(
      "abort",
      () => {
        set(resetConnectionDialogState$);
      },
      { once: true },
    );
    set(internalConnectionDialogSignal$, signal);
    set(internalConnectionDraft$, draft);
  },
);

export const openCreateModelProviderConnection$ = command(
  async (
    { get, set },
    template: ModelProviderConnectionTemplate,
    settingsDialogSignal: AbortSignal,
  ) => {
    const catalog = await get(modelCatalog$);
    settingsDialogSignal.throwIfAborted();
    set(
      openConnectionDialog$,
      templateDraft(template, catalog),
      settingsDialogSignal,
    );
  },
);

export const openEditModelProviderConnection$ = command(
  (
    { set },
    connection: ModelProviderConnectionResponse,
    settingsDialogSignal: AbortSignal,
  ) => {
    const surface = (protocol: ModelProviderSurfaceProtocol): SurfaceDraft => {
      const current = connection.surfaces.find((candidate) => {
        return candidate.protocol === protocol;
      });
      return current
        ? {
            enabled: true,
            apiBaseUrl: current.apiBaseUrl,
            authHeaderName: current.authHeaderName,
            authHeaderTemplate: current.authHeaderTemplate,
            modelMappings: JSON.stringify(current.modelMappings, null, 2),
          }
        : emptySurface();
    };
    set(
      openConnectionDialog$,
      {
        open: true,
        editingId: connection.id,
        displayName: connection.displayName,
        secret: "",
        messages: surface("anthropic-messages"),
        responses: surface("openai-responses"),
        error: null,
      },
      settingsDialogSignal,
    );
  },
);

export const closeModelProviderConnection$ = command(({ set }) => {
  set(internalConnectionDraft$, (draft) => {
    return { ...draft, open: false };
  });
});

export const completeModelProviderConnectionClose$ = command(({ get, set }) => {
  if (get(internalConnectionDraft$).open) {
    return;
  }
  set(resetConnectionDialogSignal$);
});

export const openDeleteModelProviderConnection$ = command(
  ({ set }, connection: ModelProviderConnectionResponse) => {
    set(internalPendingDeleteConnection$, connection);
  },
);

export const closeDeleteModelProviderConnection$ = command(({ set }) => {
  set(internalPendingDeleteConnection$, null);
});

export const updateModelProviderConnectionField$ = command(
  (
    { set },
    args: {
      readonly field: "displayName" | "secret";
      readonly value: string;
    },
  ) => {
    set(internalConnectionDraft$, (draft) => {
      return { ...draft, [args.field]: args.value, error: null };
    });
  },
);

export const toggleModelProviderSurface$ = command(
  ({ set }, protocol: ModelProviderSurfaceProtocol) => {
    const key = protocol === "anthropic-messages" ? "messages" : "responses";
    set(internalConnectionDraft$, (draft) => {
      return {
        ...draft,
        [key]: { ...draft[key], enabled: !draft[key].enabled },
        error: null,
      };
    });
  },
);

export const updateModelProviderSurfaceField$ = command(
  (
    { set },
    args: {
      readonly protocol: ModelProviderSurfaceProtocol;
      readonly field: SurfaceField;
      readonly value: string;
    },
  ) => {
    const key =
      args.protocol === "anthropic-messages" ? "messages" : "responses";
    set(internalConnectionDraft$, (draft) => {
      return {
        ...draft,
        [key]: { ...draft[key], [args.field]: args.value },
        error: null,
      };
    });
  },
);

function parseMappings(value: string): Record<string, string> | null {
  const parsed = jsonParseOr<unknown>(value, null);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) => {
      return typeof item !== "string";
    })
  ) {
    return null;
  }
  return parsed as Record<string, string>;
}

export const saveModelProviderConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const draft = get(internalConnectionDraft$);
    const surfaces = (
      [
        ["anthropic-messages", draft.messages],
        ["openai-responses", draft.responses],
      ] as const
    ).flatMap(([protocol, surface]) => {
      if (!surface.enabled) {
        return [];
      }
      const modelMappings = parseMappings(surface.modelMappings);
      return modelMappings
        ? [
            {
              protocol,
              apiBaseUrl: surface.apiBaseUrl,
              authHeaderName: surface.authHeaderName,
              authHeaderTemplate: surface.authHeaderTemplate,
              modelMappings,
            },
          ]
        : [];
    });
    const enabledCount =
      Number(draft.messages.enabled) + Number(draft.responses.enabled);
    if (surfaces.length !== enabledCount) {
      set(internalConnectionDraft$, { ...draft, error: "invalidMappings" });
      return;
    }
    if (surfaces.length === 0) {
      set(internalConnectionDraft$, { ...draft, error: "missingProtocol" });
      return;
    }
    if (!draft.editingId && !draft.secret.trim()) {
      set(internalConnectionDraft$, { ...draft, error: "missingSecret" });
      return;
    }

    if (draft.editingId) {
      await set(
        updateModelProviderConnection$,
        {
          id: draft.editingId,
          input: {
            displayName: draft.displayName,
            ...(draft.secret.trim() ? { secret: draft.secret } : {}),
            surfaces,
          },
        },
        signal,
      );
    } else {
      await set(
        createModelProviderConnection$,
        {
          displayName: draft.displayName,
          secret: draft.secret,
          surfaces,
        },
        signal,
      );
    }
    signal.throwIfAborted();
    set(closeModelProviderConnection$);
  },
);
