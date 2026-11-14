import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { feishuPlatform$ } from "../../signals/okou-page/feishu.ts";
import { BrandedErrorPage } from "../components/branded-error-page.tsx";
import { SettingsBackLink } from "./connect-page-shell.tsx";

export function FeishuConnectErrorPage(): React.JSX.Element {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);

  return (
    <BrandedErrorPage
      title={t(($) => {
        return $.connectors.providerConnect.common.connectionFailed;
      })}
      description={t(
        ($) => {
          return $.connectors.providerConnect.common.invalidBotConnectLink;
        },
        { provider: FEISHU_PLATFORMS[platform].name },
      )}
    >
      <SettingsBackLink />
    </BrandedErrorPage>
  );
}
