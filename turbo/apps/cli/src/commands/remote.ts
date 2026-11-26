import { randomUUID } from "node:crypto";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { remoteDeviceApprovalSchema } from "@okouai/api-contracts/validators/remote-device-approval";
import { Command } from "commander";
import { getClientConfig, handleError } from "../lib/api/core/client-factory";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { getPlatformOrigin } from "../lib/platform-url";
import { finalizeActionUrl } from "./connector/action-url";

async function readDirectory() {
  const client = initClient(remoteDevicesContract, await getClientConfig());
  const result = await client.listForRun();
  if (result.status === 404) {
    throw new Error(
      "Remote device discovery is unavailable for this Run. Use the existing protocol inventory when device access is off.",
    );
  }
  if (result.status !== 200) {
    handleError(result, "Cannot list remote devices");
  }
  return remoteDevicesContract.listForRun.responses[200].parse(result.body);
}

export const remoteCommand = new Command("remote").description(
  "Find Remote Devices and request access to their channels in the current Chat",
);

remoteCommand
  .command("list")
  .description(
    "List configured Remote Devices and their exact channel IDs in this Run",
  )
  .option("--json", "Print the device and channel inventory as JSON")
  .action(
    withErrorHandler(async (options: { readonly json?: boolean }) => {
      const { devices } = await readDirectory();
      if (options.json) {
        console.log(JSON.stringify({ devices }));
        return;
      }
      if (!devices.length) {
        console.log(
          "No configured Remote Devices are available in this Run. Add a channel in Remote settings.",
        );
        return;
      }
      const now = Date.now();
      for (const device of devices) {
        const expiry = device.accessExpiresAt;
        const access =
          !device.accessAllowed ||
          (expiry !== null && Date.parse(expiry) <= now)
            ? "Off"
            : expiry === null
              ? "Always"
              : `Allowed until ${expiry}`;
        console.log(`${device.displayName} (${device.id}) · ${access}`);
        for (const channel of device.channels) {
          console.log(
            `  ${channel.kind}: ${channel.displayName} (${channel.id})`,
          );
        }
      }
      console.log(
        "Use the exact channel ID with its protocol command. Request device access with okou remote request-access.",
      );
    }),
  );

remoteCommand
  .command("request-access")
  .description(
    "Ask the owner to allow one Remote Device for one hour across their Chats",
  )
  .argument("<device-id>", "Exact device ID from okou remote list --json")
  .requiredOption(
    "--reason <reason>",
    "Why the task needs this device (1–500 characters)",
  )
  .option(
    "--callback-prompt <prompt>",
    "Continue the task after approval when this is the only action needed",
  )
  .option("--json", "Print the exact review URL as JSON")
  .action(
    withErrorHandler(
      async (
        deviceId: string,
        options: {
          readonly reason: string;
          readonly callbackPrompt?: string;
          readonly json?: boolean;
        },
      ) => {
        const action = remoteDeviceApprovalSchema.parse({
          deviceId: deviceId.toLowerCase(),
          actionId: randomUUID(),
          reason: options.reason,
        });
        const { chatThreadId, devices } = await readDirectory();
        const device = devices.find(({ id }) => {
          return id === action.deviceId;
        });
        if (!device) {
          throw new Error(
            "Remote Device is unavailable in this Run. Select an exact ID from okou remote list --json.",
          );
        }
        const url = new URL(
          `/chats/${chatThreadId}`,
          await getPlatformOrigin(),
        );
        url.searchParams.set("remoteDeviceApproval", device.id);
        url.searchParams.set("reason", action.reason);
        url.searchParams.set("actionId", action.actionId);
        const authorizationUrl = finalizeActionUrl(
          url,
          options.callbackPrompt,
          () => {
            return chatThreadId;
          },
        );
        if (options.json) {
          console.log(
            JSON.stringify({
              deviceId: device.id,
              displayName: device.displayName,
              authorizationUrl,
            }),
          );
          return;
        }
        console.log(
          `Review one hour of access to ${device.displayName} and all its channels:`,
        );
        console.log(authorizationUrl);
        console.log(
          "Share this exact URL in the current Chat for the owner's confirmation.",
        );
      },
    ),
  );
