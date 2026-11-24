/** Build the native pilot command from the API's validated host and binding. */
export function antigravityTerminalCommand(profile: {
  readonly status: "pending" | "connected";
  readonly loginHost: string;
  readonly bindingId: string;
}): string {
  const command = ["ssh", "-t", "--", profile.loginHost];
  if (profile.status === "connected") {
    command.push("verify");
  }
  command.push(profile.bindingId);
  return command.join(" ");
}
