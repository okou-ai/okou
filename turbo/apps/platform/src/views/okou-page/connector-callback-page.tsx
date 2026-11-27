import { AlertCircle, Check, Loader2, WalletCards } from "lucide-react";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { Button, buttonVariants } from "@okouai/ui/components/ui/button";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorFlowCard } from "./connector-flow-card.tsx";
import { MercuryDisclosure } from "./components/settings/mercury-disclosure.tsx";

type ConnectorCallbackPageStatus = "loading" | "success" | "error";

interface ConnectorCallbackPageProps {
  readonly connectorIcon?: PublicConnectorCatalogIcon | undefined;
  readonly iconContent?: ReactNode;
  readonly connectorSlug: ConnectorSlug | null;
  readonly connectorLabel: string;
  readonly status: ConnectorCallbackPageStatus;
  readonly username: string | null;
  readonly errorMessage: string | null;
  readonly nativeReturnUrl?: string;
}

function linkWalletIcon(label: string) {
  return <WalletCards size={20} role="img" aria-label={label} />;
}

export function ConnectorCallbackPage({
  connectorIcon,
  iconContent,
  connectorSlug,
  connectorLabel,
  status,
  username,
  errorMessage,
  nativeReturnUrl,
}: ConnectorCallbackPageProps): React.JSX.Element {
  const { t } = useTranslation();
  const title =
    status === "success"
      ? t(
          ($) => {
            return $.connectors.callback.connected;
          },
          { connector: connectorLabel },
        )
      : status === "error"
        ? t(
            ($) => {
              return $.connectors.callback.failedTitle;
            },
            { connector: connectorLabel },
          )
        : t(
            ($) => {
              return $.connectors.callback.connecting;
            },
            { connector: connectorLabel },
          );

  return (
    <ConnectorFlowCard
      connectorSlug={connectorSlug}
      connectorIcon={connectorIcon}
      iconContent={
        connectorSlug === "link" ? linkWalletIcon(connectorLabel) : iconContent
      }
      title={title}
      description={
        <ConnectorCallbackDescription
          status={status}
          username={username}
          errorMessage={errorMessage}
          nativeReturnUrl={nativeReturnUrl}
        />
      }
    >
      {status === "loading" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          <span>
            {t(($) => {
              return $.connectors.callback.finishing;
            })}
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div
            className={
              status === "success"
                ? "flex items-center gap-2 text-sm text-emerald-600"
                : "flex items-center gap-2 text-sm text-destructive"
            }
          >
            {status === "success" ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <AlertCircle size={16} aria-hidden="true" />
            )}
            <span>
              {status === "success"
                ? t(($) => {
                    return $.connectors.callback.success;
                  })
                : t(($) => {
                    return $.connectors.callback.failed;
                  })}
            </span>
          </div>
          <ConnectorCallbackAction nativeReturnUrl={nativeReturnUrl} />
        </div>
      )}
      {connectorSlug === "mercury" ? (
        <MercuryDisclosure className="w-full border-t border-border/50 pt-4 text-left" />
      ) : null}
    </ConnectorFlowCard>
  );
}

function ConnectorCallbackDescription({
  status,
  username,
  errorMessage,
  nativeReturnUrl,
}: Pick<
  ConnectorCallbackPageProps,
  "status" | "username" | "errorMessage" | "nativeReturnUrl"
>): string {
  const { t } = useTranslation();
  if (status === "loading") {
    return t(($) => {
      return $.connectors.callback.connectingDescription;
    });
  }
  if (status === "error") {
    const error =
      errorMessage ??
      t(($) => {
        return $.connectors.callback.errorFallback;
      });
    return nativeReturnUrl
      ? t(
          ($) => {
            return $.connectors.callback.nativeErrorDescription;
          },
          { error },
        )
      : t(
          ($) => {
            return $.connectors.callback.errorDescription;
          },
          { error },
        );
  }
  if (username) {
    return nativeReturnUrl
      ? t(
          ($) => {
            return $.connectors.callback.nativeConnectedAs;
          },
          { username },
        )
      : t(
          ($) => {
            return $.connectors.callback.connectedAs;
          },
          { username },
        );
  }
  return nativeReturnUrl
    ? t(($) => {
        return $.connectors.callback.nativeConnectedDescription;
      })
    : t(($) => {
        return $.connectors.callback.connectedDescription;
      });
}

function ConnectorCallbackAction({
  nativeReturnUrl,
}: {
  readonly nativeReturnUrl?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return nativeReturnUrl ? (
    <a
      className={buttonVariants({ variant: "outline" })}
      href={nativeReturnUrl}
    >
      {t(($) => {
        return $.connectors.actions.returnToOkou;
      })}
    </a>
  ) : (
    <Button
      variant="outline"
      onClick={() => {
        window.close();
      }}
    >
      {t(($) => {
        return $.connectors.actions.closeWindow;
      })}
    </Button>
  );
}
