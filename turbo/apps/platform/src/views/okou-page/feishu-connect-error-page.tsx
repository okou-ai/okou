import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { feishuPlatform$ } from "../../signals/okou-page/feishu.ts";
import { ConnectErrorState, PageShell } from "./connect-page-shell.tsx";

export function FeishuConnectErrorPage(): React.JSX.Element {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);

  return (
    <PageShell>
      <ConnectErrorState
        message={t(
          ($) => {
            return $.connectors.providerConnect.common.invalidBotConnectLink;
          },
          { provider: FEISHU_PLATFORMS[platform].name },
        )}
      />
    </PageShell>
  );
}
