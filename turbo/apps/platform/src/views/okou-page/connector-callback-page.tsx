import { AlertCircle, Check, Loader2, WalletCards } from "lucide-react";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { Button } from "@okouai/ui/components/ui/button";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorFlowCard } from "./connector-flow-card.tsx";
import { MercuryDisclosure } from "./components/settings/mercury-disclosure.tsx";

type ConnectorCallbackPageStatus = "loading" | "success" | "error";

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
}: {
  readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
  readonly iconContent?: ReactNode;
  readonly connectorSlug: ConnectorSlug | null;
  readonly connectorLabel: string;
  readonly status: ConnectorCallbackPageStatus;
  readonly username: string | null;
  readonly errorMessage: string | null;
}): React.JSX.Element {
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
  const description =
    status === "success"
      ? username
        ? t(
            ($) => {
              return $.connectors.callback.connectedAs;
            },
            { username },
          )
        : t(($) => {
            return $.connectors.callback.connectedDescription;
          })
      : status === "error"
        ? t(
            ($) => {
              return $.connectors.callback.errorDescription;
            },
            {
              error:
                errorMessage ??
                t(($) => {
                  return $.connectors.callback.errorFallback;
                }),
            },
          )
        : t(($) => {
            return $.connectors.callback.connectingDescription;
          });

  return (
    <ConnectorFlowCard
      connectorIcon={connectorIcon}
      iconContent={
        connectorSlug === "link" ? linkWalletIcon(connectorLabel) : iconContent
      }
      title={title}
      description={description}
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
        </div>
      )}
      {connectorSlug === "mercury" ? (
        <MercuryDisclosure className="w-full border-t border-border/50 pt-4 text-left" />
      ) : null}
    </ConnectorFlowCard>
  );
}
