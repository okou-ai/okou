import { useTranslation } from "react-i18next";
import { connectorAccountEffectiveLabel } from "@okouai/api-contracts/validators/connector-accounts";
import type { ConnectorAccountIdentityFields } from "@okouai/api-contracts/contracts/connector-accounts";

interface ConnectorAccountLabelSource extends ConnectorAccountIdentityFields {
  readonly authMethod: string;
}

/**
 * Resolves the name shown for a connector account.
 *
 * `connectorAccountEffectiveLabel` already prefers displayName, then the email,
 * username or external id the provider gave us. Only connections that carry no
 * identity at all reach the fallback: custom connectors and the non-OAuth auth
 * methods, both of which store null identity columns
 * (connector-connection-write.service.ts). Those get named after how they
 * authenticate, which at least separates one from another; an opaque id slice
 * told the user nothing. OAuth methods cannot reach the fallback because their
 * external id is required at grant time.
 */
export function useConnectorAccountLabel(): (
  account: ConnectorAccountLabelSource,
) => string {
  const { t } = useTranslation();
  return (account) => {
    const fallback = (() => {
      if (account.authMethod === "api") {
        return t(($) => {
          return $.connectors.accounts.fallbackByMethod.api;
        });
      }
      if (account.authMethod === "api-token") {
        return t(($) => {
          return $.connectors.accounts.fallbackByMethod["api-token"];
        });
      }
      if (account.authMethod === "cli") {
        return t(($) => {
          return $.connectors.accounts.fallbackByMethod.cli;
        });
      }
      return t(($) => {
        return $.connectors.accounts.fallbackUnnamed;
      });
    })();
    return connectorAccountEffectiveLabel(account, fallback);
  };
}
