import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { feishuPlatform$ } from "../../signals/okou-page/feishu.ts";
import { useGet, useLastLoadable } from "ccstate-react";

import { connectorCatalogItemBySlug } from "../../signals/external/connectors.ts";
import { ConnectorCallbackPage } from "./connector-callback-page.tsx";

// The callback page draws one mark, so it reads that one catalog entry.
const larkCatalogItem$ = connectorCatalogItemBySlug("lark");

export function FeishuOAuthCallbackPage(): React.JSX.Element {
  const platform = useGet(feishuPlatform$);
  const catalogLoadable = useLastLoadable(larkCatalogItem$);
  const connectorIcon =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data?.icon
      : undefined;

  return (
    <ConnectorCallbackPage
      connectorIcon={connectorIcon}
      connectorSlug="lark"
      connectorLabel={FEISHU_PLATFORMS[platform].name}
      status="loading"
      username={null}
      errorMessage={null}
    />
  );
}
