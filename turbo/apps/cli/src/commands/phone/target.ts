import { Option } from "commander";
import {
  parseMessageTarget,
  unsupportedTargetError,
} from "../../lib/command/message-target";

export function phoneToOption(
  integration: "Phone" | "WhatsApp" = "Phone",
): Option {
  return new Option(
    "--to <target>",
    integration === "WhatsApp"
      ? "Destination: me, your independently verified WhatsApp account"
      : "Destination: me, the phone connected to your Okou account",
  ).default("me");
}

export function assertPhoneTarget(
  to: string,
  integration: "Phone" | "WhatsApp" = "Phone",
): void {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  if (target.kind !== "me") {
    throw unsupportedTargetError(
      integration,
      target,
      integration === "WhatsApp"
        ? "WhatsApp messages only go to your independently verified WhatsApp account; use --to me"
        : "Phone messages only go to the phone connected to your Okou account; use --to me",
    );
  }
}
