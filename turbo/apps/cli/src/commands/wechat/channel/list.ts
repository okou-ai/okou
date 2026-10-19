import { Command } from "commander";
import { listWechatChannels } from "../../../lib/api/domains/integrations-wechat";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
export const listCommand = new Command()
  .name("list")
  .description("List your verified WeChat direct conversation")
  .option("--json", "Print conversation IDs and status as JSON")
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      const result = await listWechatChannels();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const channel of result.channels) {
        console.log(`${channel.id}  ${channel.name}  ${channel.status}`);
        const { workspace, accountId } = channel.binding;
        console.log(`  Workspace: ${workspace.name} (${workspace.id})`);
        console.log(`  WeChat account: ${accountId}`);
      }
      if (!result.channels.length)
        console.log("No WeChat connection. Run okou wechat connect.");
    }),
  );
