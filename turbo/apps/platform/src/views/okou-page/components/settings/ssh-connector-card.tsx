import { Plus, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";
import { ConnectorEntryCard } from "./connector-entry-card.tsx";
import { SshConnectionSummary } from "../../ssh-connection-status.tsx";

export function SshConnectorCard({
  configuredCount,
}: {
  readonly configuredCount: number;
}) {
  const { t } = useTranslation();
  return (
    <ConnectorEntryCard
      icon={<Terminal size={20} aria-hidden="true" />}
      label={t(($) => {
        return $.ssh.label;
      })}
      description={t(($) => {
        return $.ssh.description;
      })}
      showDescription={configuredCount === 0}
      interactive
      action={
        <Link
          pathname={ROUTES.connectors}
          options={{
            searchParams: new URLSearchParams({
              scope: "remote-control",
              type: "ssh",
            }),
          }}
          aria-label={t(($) => {
            return $.ssh.manage;
          })}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      }
      indicator={
        configuredCount === 0 ? (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
            aria-hidden="true"
          >
            <Plus size={14} />
          </span>
        ) : null
      }
      status={<SshConnectionSummary configuredCount={configuredCount} />}
    />
  );
}
