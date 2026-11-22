import { command, computed, state } from "ccstate";
import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/client/feishu-connect";
import { larkOfficialContract } from "@okouai/api-contracts/client/lark-official";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";

const reload$ = state(0);

export const reloadFeishuChannelStatus$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

// Works shows both platforms together; settings-page signals follow the route.
function createChannelConnection(platform: FeishuPlatform) {
  return computed(async (get) => {
    get(reload$);
    const features = await get(featureSwitches$);
    const client = get(apiClient$);
    const [custom, official] = await Promise.all([
      features[FEISHU_PLATFORMS[platform].featureSwitch]
        ? accept(
            client(
              platform === "lark" ? larkConnectContract : feishuConnectContract,
            ).getStatus({}),
            [200],
          )
        : null,
      platform === "lark" && features[FeatureSwitchKey.LarkOfficialBot]
        ? accept(client(larkOfficialContract).getStatus({}), [200])
        : null,
    ]);
    return (
      custom?.body.isConnected === true ||
      custom?.body.installations?.some((installation) => {
        return installation.isConnected;
      }) === true ||
      official?.body.isConnected === true
    );
  });
}

export const worksFeishuConnections = Object.freeze({
  feishu: createChannelConnection("feishu"),
  lark: createChannelConnection("lark"),
});
