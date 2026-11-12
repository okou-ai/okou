import type { CloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { useTranslation } from "react-i18next";
import { Link } from "../router/link.tsx";

export function CloudflareConnectorReferences({
  config,
}: {
  readonly config: Pick<CloudflareAccessConfig, "customConnectors">;
}) {
  const { t } = useTranslation();
  if (!config.customConnectors?.length) {
    return null;
  }
  return (
    <section className="grid gap-2 text-sm">
      <h3 className="font-medium">
        {t(($) => {
          return $.cloudflareAccess.customConnectors;
        })}
      </h3>
      <ul className="grid gap-2">
        {config.customConnectors.map((connector) => {
          return (
            <li key={connector.id} className="break-words">
              <Link
                pathname="/connectors"
                options={{
                  searchParams: new URLSearchParams({
                    scope: "custom",
                    editCustomConnector: connector.id,
                  }),
                }}
                className="underline hover:text-foreground"
              >
                {connector.displayName}
              </Link>
              {" · "}
              {t(($) => {
                return connector.kind === "mcp"
                  ? $.connectors.custom.mcpType
                  : $.connectors.custom.create.httpType;
              })}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
