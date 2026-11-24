import { Command, InvalidArgumentError } from "commander";
import { uuid } from "zod";
import { antigravitySubscription } from "../../lib/api/domains/subscriptions";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function show(
  profile: Awaited<ReturnType<typeof antigravitySubscription>>,
  options: { json?: boolean },
) {
  if (options.json) {
    console.log(JSON.stringify(profile, null, 2));
    return;
  }
  if (profile.status === "pending") {
    console.log(
      `Open your assigned Google sign-in terminal by ${profile.expiresAt}:\nssh -t -- ${profile.loginHost} ${profile.bindingId}`,
    );
  } else if (profile.status === "expired") {
    console.log(
      "Sign-in expired. Run okou subscription antigravity connect to start again.",
    );
  } else if (profile.status === "unassigned") {
    console.log(
      "Ask an administrator to assign your Antigravity sign-in terminal.",
    );
  } else if (profile.status === "unavailable") {
    console.log(
      `The assigned worker is unavailable. Disconnect binding ${profile.bindingId} and request a new assignment.`,
    );
  } else if (profile.status === "connected") {
    console.log(`Google sign-in connected. Binding ID: ${profile.bindingId}`);
  } else {
    console.log("Google sign-in disconnected.");
  }
}

export const antigravitySubscriptionCommand = new Command("antigravity")
  .description("Manage your staff Antigravity personal Google sign-in")
  .addCommand(
    new Command("connect")
      .description("Start sign-in on your assigned worker")
      .option("--json", "Output structured JSON")
      .action(
        withErrorHandler(async (options: { json?: boolean }) => {
          show(await antigravitySubscription("connect"), options);
        }),
      ),
  )
  .addCommand(
    new Command("status")
      .description("Read your Antigravity sign-in status")
      .option("--json", "Output structured JSON")
      .action(
        withErrorHandler(async (options: { json?: boolean }) => {
          show(await antigravitySubscription("status"), options);
        }),
      ),
  )
  .addCommand(
    new Command("disconnect")
      .description("Revoke your exact Antigravity binding")
      .argument("<binding-id>", "ID from status", (value) => {
        const parsed = uuid().safeParse(value);
        if (!parsed.success)
          throw new InvalidArgumentError(
            "Use the exact ID from okou subscription antigravity status.",
          );
        return parsed.data;
      })
      .option("--json", "Output structured JSON")
      .action(
        withErrorHandler(async (id: string, options: { json?: boolean }) => {
          show(await antigravitySubscription({ disconnect: id }), options);
        }),
      ),
  );
