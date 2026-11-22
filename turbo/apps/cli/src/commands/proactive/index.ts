import { Argument, Command } from "commander";
import {
  getProactivePreference,
  updateProactivePreference,
  type ProactiveFeature,
  type ProactiveSetting,
} from "../../lib/api/domains/proactive";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function printPreference(
  feature: ProactiveFeature,
  preference: ProactiveSetting,
  json?: boolean,
) {
  if (json) {
    console.log(JSON.stringify({ feature, ...preference }));
    return;
  }
  const status =
    "status" in preference ? ` (status: ${preference.status})` : "";
  console.log(`${feature}: ${preference.enabled ? "on" : "off"}${status}`);
  if ("unavailableReason" in preference) {
    if (preference.unavailableReason === "missing-timezone") {
      console.log("Set your time zone in Settings before this can run.");
    } else if (
      preference.unavailableReason !== null &&
      preference.status !== "error"
    ) {
      console.log("Ask a workspace administrator to check availability.");
    } else if (preference.status === "error") {
      console.log(
        "The preference is saved, but setup needs attention in Settings.",
      );
    }
  }
  console.log(`Check again: okou proactive status ${feature}`);
}

export function createProactiveCommand(): Command {
  const proactive = new Command("proactive")
    .description(
      "Read, enable or disable your Proactive settings in this workspace",
    )
    .addHelpText(
      "after",
      "\nFeatures: morning-brief (daily briefing), suggestions (hourly checks, daily user-profile updates and new suggestion cards), whats-new (product updates), offers, system-updates (system notifications).\nSuggestions enable/disable changes the scheduled checks, profile updates and card delivery together; status reports the scheduled workflows.\nEach command affects only your own preference in the current workspace. Saved intent and runtime status are reported separately.",
    );

  for (const operation of ["status", "enable", "disable"] as const) {
    proactive.addCommand(
      new Command(operation)
        .description(
          operation === "status"
            ? "Read a feature's saved preference and runtime status"
            : `${operation === "enable" ? "Enable" : "Disable"} one Proactive feature`,
        )
        .addArgument(
          new Argument("<feature>", "Proactive feature").choices([
            "morning-brief",
            "suggestions",
            "whats-new",
            "offers",
            "system-updates",
          ]),
        )
        .option(
          "--json",
          "Print the saved preference and runtime status as JSON",
        )
        .action(
          withErrorHandler(
            async (feature: ProactiveFeature, options: { json?: boolean }) => {
              const preference =
                operation === "status"
                  ? await getProactivePreference(feature)
                  : await updateProactivePreference(
                      feature,
                      operation === "enable",
                    );
              printPreference(feature, preference, options.json);
            },
          ),
        ),
    );
  }
  return proactive;
}
