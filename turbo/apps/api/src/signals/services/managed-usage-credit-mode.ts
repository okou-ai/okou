import type { CreditBillingMode } from "@okouai/db/schema/credit-billing-mode";
import { command, state } from "ccstate";
import { writeDb$ } from "../external/db";
import { getAdmittedCreditBillingMode } from "./usage-credit-mode.service";

interface Actor {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
}

function actorKey(actor: Actor): string {
  return JSON.stringify([actor.orgId, actor.userId, actor.runId ?? null]);
}

// The existing request Store owns both admission and publication. Detached jobs
// persist the returned mode; a fresh Store must never reclassify at publication.
const admittedModes$ = state<ReadonlyMap<string, CreditBillingMode | null>>(
  new Map(),
);

export const captureManagedCreditBillingMode$ = command(
  async ({ get, set }, actor: Actor, signal: AbortSignal) => {
    const mode = await getAdmittedCreditBillingMode(set(writeDb$), actor);
    signal.throwIfAborted();
    set(
      admittedModes$,
      new Map(get(admittedModes$)).set(actorKey(actor), mode),
    );
    return mode;
  },
);

export const admittedManagedCreditBillingMode$ = command(
  ({ get }, actor: Actor): CreditBillingMode | null => {
    return get(admittedModes$).get(actorKey(actor)) ?? null;
  },
);
