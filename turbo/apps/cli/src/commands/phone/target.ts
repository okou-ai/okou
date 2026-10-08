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
