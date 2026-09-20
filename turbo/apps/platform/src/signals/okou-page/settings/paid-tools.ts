import { command, computed, state } from "ccstate";
import {
  PAID_TOOL_IDS,
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../../auth.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { reloadDisabledPaidTools$ } from "../paid-tools.ts";
import {
  settingsActiveSection$,
  settingsDialogOpen$,
  settingsVisit$,
} from "./settings-dialog.ts";

function createPaidToolsSignals(
  createClient: ApiClientFactory,
  assertCurrent: () => void,
) {
  const client = createClient(paidToolsContract, {
    getTokenGuard: () => {
      assertCurrent();
      return assertCurrent;
    },
  });
  const revision$ = state(0);
  const confirmedChanges$ = state<Partial<Record<PaidToolId, boolean>>>({});
  const disabledTools$ = computed(async (get) => {
    get(revision$);
    assertCurrent();
    const response = await accept(client.get(), [200]);
    assertCurrent();
    return response.body.disabledTools;
  });
  const retry$ = command(({ set }) => {
    assertCurrent();
    set(revision$, (revision) => {
      return revision + 1;
    });
  });
  const tools = PAID_TOOL_IDS.map((toolId) => {
    const enabled$ = computed(async (get) => {
      const changes = get(confirmedChanges$);
      const disabledTools = await get(disabledTools$);
      return !(changes[toolId] ?? disabledTools.includes(toolId));
    });
    const update$ = command(
      async ({ set }, enabled: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        assertCurrent();
        const response = await accept(
          client.update({
            params: { toolId },
            body: { disabled: !enabled },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        signal.throwIfAborted();
        assertCurrent();
        // Merge only the confirmed tool so simultaneous saves cannot replace
        // another row's result with an older full-list response.
        set(confirmedChanges$, (changes) => {
          return {
            ...changes,
            [response.body.toolId]: response.body.disabled,
          };
        });
        set(reloadDisabledPaidTools$);
      },
    );
    return { toolId, enabled$, update$ };
  });
  return { disabledTools$, retry$, tools };
}

const paidToolsAvailable$ = computed((get) => {
  const features = get(featureSwitch$);
  return (
    (features[FeatureSwitchKey.ChatPreference] ?? false) &&
    (features[FeatureSwitchKey.PaidToolControls] ?? false)
  );
});

const paidToolsActive$ = computed((get) => {
  return get(settingsActiveSection$) === "chat";
});

/** One current identity and settings visit; same-identity refreshes retain it. */
export const paidToolsSettings$ = computed(async (get) => {
  const visit = get(settingsVisit$);
  const open = get(settingsDialogOpen$);
  const active = get(paidToolsActive$);
  const enabled = get(paidToolsAvailable$);
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  if (!open || !active || !enabled || !identity) {
    return null;
  }
  const clerk = await get(clerk$);
  const assertCurrent = () => {
    if (
      !clerk.user ||
      !clerk.organization ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== identity
    ) {
      throw new DOMException("Paid tools settings owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    key: `${identity}:${visit}`,
    ...createPaidToolsSignals(createClient, assertCurrent),
  };
});

export type PaidToolsSettings = ReturnType<typeof createPaidToolsSignals> & {
  readonly key: string;
};
export type PaidToolSettings = PaidToolsSettings["tools"][number];
