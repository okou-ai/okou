import {
  stripeConnectionReadiness,
  stripeLiveModeReadinessMessage,
} from "./stripe-invoice-paid-workflow-automation.service";
import { command } from "ccstate";
import { z } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { rawSqlReadDb$ } from "../external/db";
import {
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
} from "./builtin-connector-credential-runtime.service";
import { createConnectorRuntimeAuthSelection } from "./connector-catalog-slug-source.service";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";

const stripeRuntimeAuthSelection$ = createConnectorRuntimeAuthSelection({
  connectorSlugs: ["stripe"],
});
const STRIPE_LIVEMODE_VALUE_REF = "$vars.STRIPE_LIVEMODE";

type StripeBindingReadResult =
  | {
      readonly kind: "ok";
      readonly binding: {
        readonly connectorId: string;
        readonly stripeAccountId: string;
        readonly mode: "live";
      };
    }
  | { readonly kind: "bad_request"; readonly message: string };

const readReadyStripeConnection$ = command(
  async (
    { get, set },
    args: {
      readonly connectorId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<StripeBindingReadResult> => {
    const snapshot = await get(stripeRuntimeAuthSelection$);
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      ...args,
      snapshot,
      connectorSlug: "stripe",
    });
    signal.throwIfAborted();
    const ready = stripeConnectionReadiness(
      loaded,
      "The selected Stripe account changed; retry the operation",
    );
    if (ready.kind === "bad_request") {
      return ready;
    }
    const values = await set(
      loadBuiltinConnectorCredentialValues$,
      {
        connection: ready.connection,
        valueRefs: [STRIPE_LIVEMODE_VALUE_REF],
      },
      signal,
    );
    signal.throwIfAborted();
    const liveMode = values.get(STRIPE_LIVEMODE_VALUE_REF);
    const modeError = stripeLiveModeReadinessMessage(liveMode);
    if (modeError !== null) {
      return { kind: "bad_request", message: modeError };
    }

    return {
      kind: "ok",
      binding: {
        connectorId: ready.connection.connectorId,
        stripeAccountId: ready.stripeAccountId,
        mode: "live",
      },
    };
  },
);

export const readStripeInvoicePaidAutomationBinding$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<StripeBindingReadResult> => {
    const db = get(rawSqlReadDb$);
    const [selection] = parseRawRows(
      z.object({ connectorId: z.string().nullable() }),
      await db.execute(
        workflowAutomationConnectorSelectionSql({
          ...args,
          connectorSlug: "stripe",
        }),
      ),
    );
    signal.throwIfAborted();
    const connectorId = selection?.connectorId ?? null;
    if (connectorId === null) {
      return {
        kind: "bad_request",
        message:
          "Connect Stripe with OAuth in Live mode before adding a Stripe invoice-paid automation",
      };
    }
    return await set(
      readReadyStripeConnection$,
      { ...args, connectorId },
      signal,
    );
  },
);
