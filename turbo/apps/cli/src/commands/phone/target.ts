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

export function phoneFileToOption(): Option {
  return new Option(
    "--to <target>",
    "Destination: me, chat:grp_<id>, or grp_<id> (an iMessage group you belong to)",
  ).default("me");
}

export function phoneFileGroupId(to: string): string | undefined {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  if (target.kind === "me") {
    return undefined;
  }
  if (
    target.kind === "chat" &&
    /^grp_.+$/u.test(target.id) &&
    target.id.length <= 255
  ) {
    return target.id;
  }
  throw unsupportedTargetError(
    "Phone file uploads",
    target,
    "Use --to me or --to chat:grp_<id> for an iMessage group you belong to",
  );
}
