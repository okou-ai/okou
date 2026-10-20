import { useTranslation } from "react-i18next";
import type { LoadableState } from "ccstate-react";
import { Button } from "@okouai/ui";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";

type ConnectorAgentAccessStatus = "loading" | "unavailable" | "ready";

export function connectorAgentAccessStatus(
  state: LoadableState,
): ConnectorAgentAccessStatus {
  if (state === "hasData") {
    return "ready";
  }
  if (state === "hasError") {
    return "unavailable";
  }
  return "loading";
}

export function ConnectorAgentAccessButton({
  agents,
  status,
  allowAccessIncrease,
  connectorLabel,
  onClick,
}: {
  readonly agents: readonly AgentResponse[];
  readonly status: ConnectorAgentAccessStatus;
  readonly allowAccessIncrease: boolean;
  readonly connectorLabel: string;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  const unnamed = t(($) => {
    return $.connectors.catalog.unnamedAgent;
  });
  const singleAgentName =
    agents.length === 1 ? (agents[0]?.displayName ?? unnamed) : undefined;

  if (status === "ready" && agents.length === 0 && !allowAccessIncrease) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="quiet"
      size="xs"
      className="min-w-0 max-w-full gap-0 px-2 text-xs"
      aria-label={t(
        ($) => {
          return $.connectors.catalog.access.manage;
        },
        { connector: connectorLabel },
      )}
      data-testid="connector-card-agent-access"
      disabled={status !== "ready"}
      onClick={onClick}
    >
      {status === "loading" ? (
        <span className="block h-3 w-20 animate-pulse rounded bg-muted" />
      ) : status === "unavailable" ? (
        <span className="truncate text-muted-foreground">
          {t(($) => {
            return $.connectors.catalog.access.unavailable;
          })}
        </span>
      ) : agents.length === 0 ? (
        <span
          className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
          data-testid="connector-card-access-empty"
        >
          {t(($) => {
            return $.connectors.catalog.access.add;
          })}
        </span>
      ) : (
        <>
          <span className="shrink-0">
            {t(($) => {
              return $.connectors.catalog.access.usedBy;
            }).trimEnd()}
            {"\u00a0"}
          </span>
          <span
            className="min-w-0 truncate underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
            data-testid="connector-card-access-names"
          >
            {agents.length === 1
              ? singleAgentName
              : t(
                  ($) => {
                    return $.connectors.catalog.access.summaryMany;
                  },
                  { value: agents.length },
                )}
          </span>
        </>
      )}
    </Button>
  );
}
