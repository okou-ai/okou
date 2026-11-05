import { command, type Command } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { captureSourceOnboardingConnected$ } from "../../bootstrap/source-onboarding-telemetry.ts";
import {
  routeChatActionCallback$,
  type ChatActionCallback,
} from "../../chat-page/action-callback.ts";
import { completeDirectedConnectorAction$ } from "../../connectors-page/directed-connector-callback.ts";
import { setManualGrantDialogKey$ } from "../../connectors-page/directed-connect-slug.ts";
import {
  finishConnectorAccountConnection$,
  type ConnectorAccountConnectMode,
} from "./connector-account-dialogs.ts";
import {
  connectBuiltinConnectorNoAuthAndSettle$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  submitBuiltinManualGrantAndSettle$,
} from "./connectors.ts";

/**
 * Where a built-in connector connection was started. The connect command
 * derives what follows an accepted connection from it, so a view describes
 * its surface instead of passing a continuation.
 */
type ConnectorConnectOrigin =
  /** Nothing follows beyond the connection itself. */
  | { readonly kind: "none" }
  /** Connector settings: add or reconnect an account of this connector. */
  | { readonly kind: "account"; readonly mode: ConnectorAccountConnectMode }
  /** The onboarding source step. */
  | { readonly kind: "onboarding-source" }
  /** The standalone connect route that a chat action linked to. */
  | { readonly kind: "directed-connect"; readonly agentId: string | null };

/**
 * The form surface that started the connection. A dialog surface is closed by
 * the command once the origin's continuation has settled.
 */
type ConnectorConnectSurface = "inline" | "directed-manual-grant-dialog";

interface ConnectedConnector {
  readonly slug: ConnectorSlug;
  readonly label?: string;
}

/** An origin resolved against the state it continues, captured at start. */
type ConnectorConnectPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "account";
      readonly connector: ConnectedConnector;
      readonly mode: ConnectorAccountConnectMode;
    }
  | {
      readonly kind: "onboarding-source";
      readonly connectorSlug: ConnectorSlug;
    }
  | {
      readonly kind: "directed-connect";
      readonly agentId: string | null;
      readonly callback: ChatActionCallback;
    };

/**
 * Resolves the origin when the connection starts, so the continuation follows
 * the surface the member acted on even if the route changes meanwhile.
 */
const resolveConnectorConnectPlan$ = command(
  (
    { get },
    origin: ConnectorConnectOrigin,
    connector: ConnectedConnector,
  ): ConnectorConnectPlan => {
    switch (origin.kind) {
      case "none": {
        return origin;
      }
      case "account": {
        return { kind: "account", connector, mode: origin.mode };
      }
      case "onboarding-source": {
        return { kind: "onboarding-source", connectorSlug: connector.slug };
      }
      case "directed-connect": {
        return {
          kind: "directed-connect",
          agentId: origin.agentId,
          callback: get(routeChatActionCallback$),
        };
      }
    }
  },
);

const continueConnectorConnectPlan$ = command(
  async (
    { set },
    plan: ConnectorConnectPlan,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    switch (plan.kind) {
      case "none": {
        return;
      }
      case "account": {
        await set(
          finishConnectorAccountConnection$,
          {
            target: { kind: "builtin", connectorSlug: plan.connector.slug },
            connectionId,
            connectorLabel: plan.connector.label ?? plan.connector.slug,
            mode: plan.mode,
          },
          signal,
        );
        return;
      }
      case "onboarding-source": {
        set(captureSourceOnboardingConnected$, plan.connectorSlug);
        return;
      }
      case "directed-connect": {
        await set(
          completeDirectedConnectorAction$,
          plan.agentId,
          plan.callback,
          signal,
        );
        return;
      }
    }
  },
);

/** Runs the plan, then closes the dialog surface that started the connection. */
const finishConnectorConnect$ = command(
  async (
    { set },
    plan: ConnectorConnectPlan,
    surface: ConnectorConnectSurface,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(continueConnectorConnectPlan$, plan, connectionId, signal);
    signal.throwIfAborted();
    if (surface === "directed-manual-grant-dialog") {
      set(setManualGrantDialogKey$, null, signal);
    }
  },
);

type CommandArgs<Target> =
  Target extends Command<unknown, infer Args> ? Args : never;

/** The settle command's arguments with its continuation replaced by an origin. */
type ContinuedArgs<Target> = Omit<CommandArgs<Target>[0], "onSuccess"> & {
  readonly origin: ConnectorConnectOrigin;
  readonly surface?: ConnectorConnectSurface;
};

type ManualGrantArgs = ContinuedArgs<typeof submitBuiltinManualGrantAndSettle$>;
type NoAuthArgs = ContinuedArgs<typeof connectBuiltinConnectorNoAuthAndSettle$>;
type OAuthAuthCodeArgs = ContinuedArgs<
  typeof connectBuiltinConnectorOAuthAuthCodeAndSettle$
>;

/** Each command stays busy until the origin's continuation has settled. */
export const submitBuiltinManualGrantAndContinue$ = command(
  async (
    { set },
    { origin, surface = "inline", ...args }: ManualGrantArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const plan = set(resolveConnectorConnectPlan$, origin, {
      slug: args.connectorSlug,
      label: args.options.connectorLabel,
    });
    await set(
      submitBuiltinManualGrantAndSettle$,
      {
        ...args,
        onSuccess: (connectionId, attemptSignal) => {
          return set(
            finishConnectorConnect$,
            plan,
            surface,
            connectionId,
            attemptSignal,
          );
        },
      },
      signal,
    );
  },
);

export const connectBuiltinConnectorNoAuthAndContinue$ = command(
  async (
    { set },
    { origin, surface = "inline", ...args }: NoAuthArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const plan = set(resolveConnectorConnectPlan$, origin, {
      slug: args.connectorSlug,
      label: args.options.connectorLabel,
    });
    await set(
      connectBuiltinConnectorNoAuthAndSettle$,
      {
        ...args,
        onSuccess: (connectionId, attemptSignal) => {
          return set(
            finishConnectorConnect$,
            plan,
            surface,
            connectionId,
            attemptSignal,
          );
        },
      },
      signal,
    );
  },
);

export const connectBuiltinConnectorOAuthAuthCodeAndContinue$ = command(
  async (
    { set },
    { origin, surface = "inline", ...args }: OAuthAuthCodeArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const plan = set(resolveConnectorConnectPlan$, origin, {
      slug: args.connectorSlug,
      label: args.options.connectorLabel,
    });
    await set(
      connectBuiltinConnectorOAuthAuthCodeAndSettle$,
      {
        ...args,
        onSuccess: (connectionId, attemptSignal) => {
          return set(
            finishConnectorConnect$,
            plan,
            surface,
            connectionId,
            attemptSignal,
          );
        },
      },
      signal,
    );
  },
);
