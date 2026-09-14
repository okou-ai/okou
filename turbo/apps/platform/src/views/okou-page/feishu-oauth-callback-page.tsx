import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { feishuPlatform$ } from "../../signals/okou-page/feishu.ts";
import { useGet, useLastLoadable } from "ccstate-react";

import { connectorCatalogStatusBySlug$ } from "../../signals/external/connectors.ts";
import { ConnectorCallbackPage } from "./connector-callback-page.tsx";

export function FeishuOAuthCallbackPage(): React.JSX.Element {
  const platform = useGet(feishuPlatform$);
  const catalogLoadable = useLastLoadable(connectorCatalogStatusBySlug$);
  const connectorIcon =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.get("lark")?.icon
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
