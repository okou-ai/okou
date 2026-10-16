import { Command } from "commander";
import { getPlatformOrigin } from "../../lib/platform-url";
import { withErrorHandler } from "../../lib/command/with-error-handler";
export const connectCommand = new Command()
  .name("connect")
  .description("Connect WeChat by scanning a QR code in Works")
  .option("--json", "Print the Works connection URL as JSON")
  .addHelpText(
    "after",
    "\nOpen Works, select the intended workspace, click WeChat Connect, then scan and confirm with WeChat. Never paste provider tokens or verification codes into this CLI.",
  )
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      const url = new URL("/works", await getPlatformOrigin()).toString();
      if (options.json) {
        console.log(JSON.stringify({ url, flow: "connect" }, null, 2));
        return;
      }
      console.log(url);
      console.log(
        "Open Works in the intended workspace, click WeChat Connect, then scan and confirm. This CLI has not connected your account.",
      );
    }),
  );
