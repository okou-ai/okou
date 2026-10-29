import { Option } from "commander";
import {
  parseMessageTarget,
  unsupportedTargetError,
} from "../../lib/command/message-target";

export function phoneToOption(): Option {
  return new Option(
    "--to <target>",
    "Destination: me, the phone connected to your Okou account",
  ).default("me");
}

export function assertPhoneTarget(to: string): void {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  if (target.kind !== "me") {
    throw unsupportedTargetError(
      "Phone",
      target,
      "Phone messages only go to the phone connected to your Okou account; use --to me",
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
