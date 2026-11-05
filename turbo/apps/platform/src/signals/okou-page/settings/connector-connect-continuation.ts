import { command, type Command, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../../i18n/index.ts";
import { agents$ } from "../../agent.ts";
import { captureSourceOnboardingConnected$ } from "../../bootstrap/source-onboarding-telemetry.ts";
import {
  routeChatActionCallback$,
  type ChatActionCallback,
} from "../../chat-page/action-callback.ts";
import {
  activeChatConnectorAction$,
  closeChatConnectorActionConnectDialog$,
  completeCatalogConnectorChatAction$,
  completeExactReconnectChatAction$,
} from "../../chat-page/connector-action-block.ts";
import {
  completeDirectedConnectorAuthorization$,
  setDirectedAuthorizeConnectModalKey$,
} from "../../connectors-page/directed-authorize-slug.ts";
import { completeDirectedConnectorAction$ } from "../../connectors-page/directed-connector-callback.ts";
import {
  setDirectedConnectModalKey$,
  setManualGrantDialogKey$,
} from "../../connectors-page/directed-connect-slug.ts";
import {
  closeGoogleCalendarReconnect$,
  finishGoogleCalendarReconnect$,
  googleCalendarRecoveryTarget$,
} from "../../workflows-page/google-calendar-recovery.ts";
import {
  composerConnectHosts$,
  type ComposerConnectHost,
} from "../composer-connect-hosts.ts";
import type { ComposerConnectorData } from "../connectors.ts";
import {
  closeBuiltinAccountConnectDialog$,
  finishConnectorAccountConnection$,
  type ConnectorAccountConnectMode,
} from "./connector-account-dialogs.ts";
import {
  clearBuiltinConnectorExternalCode$,
  clearBuiltinConnectorOAuthDeviceAuth$,
  completeBuiltinConnectorExternalCodeAndSettle$,
  connectBuiltinConnectorNoAuthAndSettle$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  connectBuiltinConnectorOAuthDeviceAuthAndSettle$,
  setSelectedBuiltinConnectorSlug$,
  submitBuiltinManualGrantAndSettle$,
} from "./connectors.ts";

/**
 * Where a built-in connector connection was started. The connect command
 * derives what follows an accepted connection from it, and which surface to
 * close, so a view describes where it is instead of passing a continuation.
 */
export type ConnectorConnectOrigin =
  /** Nothing follows beyond the connection itself. */
  | { readonly kind: "none" }
  /** Connector settings: add or reconnect an account of this connector. */
  | { readonly kind: "account"; readonly mode: ConnectorAccountConnectMode }
  /** A surface that tracks its connector as the selected built-in connector. */
  | {
      readonly kind: "selected-connector";
      /** The onboarding source step records the connection. */
      readonly captureOnboardingSource: boolean;
    }
  /** The chat connector action that opened the connect dialog. */
  | { readonly kind: "chat-action" }
  /** The Google Calendar automation being recovered. */
  | { readonly kind: "google-calendar-recovery" }
  /** The standalone connect route that a chat action linked to. */
  | { readonly kind: "directed-connect"; readonly agentId: string | null }
  /** The standalone authorize route that a chat action linked to. */
  | { readonly kind: "directed-authorize"; readonly agentId: string }
  /** The composer registered under this key. */
  | { readonly kind: "composer"; readonly hostKey: string };

/**
 * The form surface that started the connection. A dialog surface is closed by
 * the command once the origin's continuation has settled.
 */
type ConnectorConnectSurface =
  "inline" | "connect-modal" | "directed-manual-grant-dialog";

interface ConnectedConnector {
  readonly slug: ConnectorSlug;
  readonly label?: string;
}

type ResolvedValue<Target> =
  Target extends Computed<infer Value> ? Awaited<Value> : never;
type ActiveChatConnectorAction = NonNullable<
  ResolvedValue<typeof activeChatConnectorAction$>
>;
type GoogleCalendarRecoveryTarget = NonNullable<
  ResolvedValue<typeof googleCalendarRecoveryTarget$>
>;

/** An origin resolved against the state it continues, captured at start. */
type ConnectorConnectPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "account";
      readonly connector: ConnectedConnector;
      readonly mode: ConnectorAccountConnectMode;
    }
  | {
      readonly kind: "selected-connector";
      readonly connectorSlug: ConnectorSlug;
      readonly captureOnboardingSource: boolean;
    }
  | { readonly kind: "chat-action"; readonly action: ActiveChatConnectorAction }
  | {
      readonly kind: "google-calendar-recovery";
      readonly recovery: GoogleCalendarRecoveryTarget;
    }
  | {
      readonly kind: "directed-connect";
      readonly agentId: string | null;
      readonly callback: ChatActionCallback;
    }
  | {
      readonly kind: "directed-authorize";
      readonly agentId: string;
      readonly callback: ChatActionCallback;
    }
  | {
      readonly kind: "composer";
      readonly host: ComposerConnectHost;
      readonly connector: ConnectedConnector;
      /** The composer's connector data before this connection changed it. */
      readonly dataAtStart: Promise<
        [PromiseSettledResult<ComposerConnectorData>]
      >;
    };

/**
 * Resolves the origin when the connection starts, so the continuation follows
 * the surface the member acted on even if another one opens meanwhile. It must
 * stay synchronous: browser authorization opens its window from this event.
 */
const resolveConnectorConnectPlan$ = command(
  (
    { get },
    origin: ConnectorConnectOrigin,
    connector: ConnectedConnector,
  ): ConnectorConnectPlan => {
    switch (origin.kind) {
      case "none": {
        return { kind: "none" };
      }
      case "account": {
        return { kind: "account", connector, mode: origin.mode };
      }
      case "selected-connector": {
        return {
          kind: "selected-connector",
          connectorSlug: connector.slug,
          captureOnboardingSource: origin.captureOnboardingSource,
        };
      }
      case "chat-action": {
        const action = get(activeChatConnectorAction$);
        return action ? { kind: "chat-action", action } : { kind: "none" };
      }
      case "google-calendar-recovery": {
        const recovery = get(googleCalendarRecoveryTarget$);
        return recovery
          ? { kind: "google-calendar-recovery", recovery }
          : { kind: "none" };
      }
      case "directed-connect": {
        return {
          kind: "directed-connect",
          agentId: origin.agentId,
          callback: get(routeChatActionCallback$),
        };
      }
      case "directed-authorize": {
        return {
          kind: "directed-authorize",
          agentId: origin.agentId,
          callback: get(routeChatActionCallback$),
        };
      }
      case "composer": {
        const host = get(composerConnectHosts$).get(origin.hostKey);
        if (!host) {
          return { kind: "none" };
        }
        return {
          kind: "composer",
          host,
          connector,
          // Settled at once, so a failed read cannot reject unobserved while
          // the connection is in progress.
          dataAtStart: Promise.allSettled([get(host.connector.data$)]),
        };
      }
    }
  },
);

const finishComposerConnectorAddition$ = command(
  async (
    { get, set },
    plan: Extract<ConnectorConnectPlan, { kind: "composer" }>,
    signal: AbortSignal,
  ): Promise<void> => {
    const [dataAtStart] = await plan.dataAtStart;
    signal.throwIfAborted();
    // An unreadable authorization reads as not yet authorized, as the composer
    // showed before this connection.
    const authorization =
      dataAtStart.status === "fulfilled"
        ? dataAtStart.value.authorization
        : undefined;
    const alreadyAuthorized =
      authorization?.agentId === plan.host.agentId &&
      authorization.enabledConnectorSlugs.includes(plan.connector.slug);
    const newlyAuthorized = await set(
      plan.host.completeConnectorAddition$,
      plan.connector.slug,
      alreadyAuthorized,
      signal,
    );
    signal.throwIfAborted();
    if (newlyAuthorized) {
      const agents = await get(agents$);
      signal.throwIfAborted();
      toast.success(
        i18n.t(
          ($) => {
            return $.chat.connectors.authorized;
          },
          {
            connectorName: plan.connector.label ?? plan.connector.slug,
            agentName:
              agents.find((agent) => {
                return agent.agentId === plan.host.agentId;
              })?.displayName ?? "",
          },
        ),
        { id: `connector-connected-${plan.connector.slug}` },
      );
    }
    set(plan.host.connector.updateConnectorUiState$, { showAddDialog: false });
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
      case "selected-connector": {
        if (plan.captureOnboardingSource) {
          set(captureSourceOnboardingConnected$, plan.connectorSlug);
        }
        return;
      }
      case "chat-action": {
        if (plan.action.kind === "catalog-reconnect") {
          await set(
            completeExactReconnectChatAction$,
            plan.action,
            connectionId,
            signal,
          );
        } else if (plan.action.kind === "catalog") {
          await set(completeCatalogConnectorChatAction$, plan.action, signal);
        }
        return;
      }
      case "google-calendar-recovery": {
        await set(
          finishGoogleCalendarReconnect$,
          plan.recovery,
          connectionId,
          signal,
        );
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
      case "directed-authorize": {
        await set(
          completeDirectedConnectorAuthorization$,
          plan.agentId,
          plan.callback,
          signal,
        );
        return;
      }
      case "composer": {
        await set(finishComposerConnectorAddition$, plan, signal);
        return;
      }
    }
  },
);

/** Closes the connect dialog of the origin's surface after a connection. */
const closeConnectorConnectModal$ = command(
  ({ set }, plan: ConnectorConnectPlan, signal: AbortSignal): void => {
    set(clearBuiltinConnectorOAuthDeviceAuth$);
    set(clearBuiltinConnectorExternalCode$);
    switch (plan.kind) {
      case "none": {
        return;
      }
      case "account": {
        set(closeBuiltinAccountConnectDialog$);
        return;
      }
      case "selected-connector": {
        set(setSelectedBuiltinConnectorSlug$, null);
        return;
      }
      case "chat-action": {
        set(closeChatConnectorActionConnectDialog$);
        return;
      }
      case "google-calendar-recovery": {
        set(closeGoogleCalendarReconnect$, plan.recovery);
        return;
      }
      case "directed-connect": {
        set(setDirectedConnectModalKey$, null, signal);
        return;
      }
      case "directed-authorize": {
        set(setDirectedAuthorizeConnectModalKey$, null, signal);
        return;
      }
      case "composer": {
        set(plan.host.connector.updateConnectorUiState$, {
          selectedConnectorSlug: null,
          selectedConnector: null,
        });
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
    if (surface === "connect-modal") {
      set(closeConnectorConnectModal$, plan, signal);
    } else if (surface === "directed-manual-grant-dialog") {
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
type OAuthDeviceAuthArgs = ContinuedArgs<
  typeof connectBuiltinConnectorOAuthDeviceAuthAndSettle$
>;
type ExternalCodeArgs = ContinuedArgs<
  typeof completeBuiltinConnectorExternalCodeAndSettle$
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

export const connectBuiltinConnectorOAuthDeviceAuthAndContinue$ = command(
  async (
    { set },
    { origin, surface = "inline", ...args }: OAuthDeviceAuthArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const plan = set(resolveConnectorConnectPlan$, origin, {
      slug: args.connectorSlug,
      label: args.options.connectorLabel,
    });
    await set(
      connectBuiltinConnectorOAuthDeviceAuthAndSettle$,
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

export const completeBuiltinConnectorExternalCodeAndContinue$ = command(
  async (
    { set },
    { origin, surface = "inline", ...args }: ExternalCodeArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const plan = set(resolveConnectorConnectPlan$, origin, {
      slug: args.connectorSlug,
      label: args.options.connectorLabel,
    });
    await set(
      completeBuiltinConnectorExternalCodeAndSettle$,
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
