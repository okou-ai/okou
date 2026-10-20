import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createComputerUsePrompt(
  event$: Computed<Promise<Pick<PickedThreadInputEvent, "contextType"> | null>>,
  hostGrant$: Computed<Promise<{ readonly displayName: string } | null>>,
  features$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [event, host, features] = await Promise.all([
      get(event$),
      get(hostGrant$),
      get(features$),
    ]);
    const automation = event?.contextType === "automation";
    return {
      systemPromptVariables: {
        computerUseContext: host
          ? [
              "# Computer Use",
              `Computer Use is enabled for this run on ${host.displayName}.`,
              ...(isFeatureEnabled(FeatureSwitchKey.DesktopShell, features)
                ? [
                    "Interactive Mac Shell: use `okou computer-use shell --help`. Shell commands use this same authorized computer; no host or SSH connection is needed. The user must enable Shell Access in Desktop Developer Tools.",
                    "Every Shell operation requires temporary user approval for this chat and computer. If access is required, run `okou computer-use shell request-access --reason '<why this task needs Shell>'`, share its authorization link, and end the current Run. The user can approve after this Run ends; approval automatically starts the next round. Recheck access there. Do not wait for approval or replay uncertain input. Approval lasts one hour; expiry/revocation blocks subsequent operations while existing PTYs retain their normal idle lifetime.",
                    "Use `shell cmd '<command>'` to run, `shell cmd --session <id> --input '<exact text>'` or `--key Enter` / `--key Ctrl+C` to interact, and `shell cmd --session <id> --cursor <nextCursor>` with no command to observe without replaying input. A result with commandState=running is not command completion; use the returned state and exitCode.",
                    "Shell sessions belong to this computer/account/workspace across runs, start at Mac home unless --cwd is used for creation, and retain cd/environment. `shell list` lists its live sessions; multiple sessions require --session. Sessions close after 15 minutes without agent interaction, including unattended jobs. list/status and program output do not renew that timer. Never resend uncertain input after an operation timeout or reconnect.",
                  ]
                : []),
              ...(automation
                ? []
                : [
                    "Use Okou CLI computer-use commands to inspect apps, read app state, and perform desktop actions.",
                    "The computer may go offline while this run is active. If a command reports that the computer is unavailable or offline, ask the user to reconnect Okou Computer Use on that computer, then retry.",
                  ]),
            ].join(automation ? "\n\n" : "\n")
          : "",
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
