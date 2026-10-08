import { Plus, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";
import { ConnectorEntryCard } from "./connector-entry-card.tsx";

/** Directory entry for adding a first VNC connection. */
export function VncConnectorCard() {
  const { t } = useTranslation();
  return (
    <ConnectorEntryCard
      icon={<Monitor size={20} aria-hidden="true" />}
      label={t(($) => {
        return $.vnc.label;
      })}
      description={t(($) => {
        return $.vnc.description;
      })}
      showDescription
      interactive
      action={
        <Link
          pathname={ROUTES.connectors}
          options={{
            searchParams: new URLSearchParams({
              scope: "remote-control",
              type: "vnc",
            }),
          }}
          aria-label={t(($) => {
            return $.vnc.manage;
          })}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      }
      indicator={
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
          aria-hidden="true"
        >
          <Plus size={14} />
        </span>
      }
    />
  );
}
