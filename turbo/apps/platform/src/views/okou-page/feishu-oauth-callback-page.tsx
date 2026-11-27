import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { feishuPlatform$ } from "../../signals/okou-page/feishu.ts";
import { useGet } from "ccstate-react";

import { ConnectorCallbackPage } from "./connector-callback-page.tsx";

export function FeishuOAuthCallbackPage(): React.JSX.Element {
  const platform = useGet(feishuPlatform$);
  return (
    <ConnectorCallbackPage
      connectorSlug="lark"
      connectorLabel={FEISHU_PLATFORMS[platform].name}
      status="loading"
      username={null}
      errorMessage={null}
    />
  );
}
