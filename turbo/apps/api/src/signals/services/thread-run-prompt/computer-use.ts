import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createComputerUsePrompt(
  event$: Computed<Promise<Pick<PickedThreadInputEvent, "contextType"> | null>>,
  hostGrant$: Computed<Promise<{ readonly displayName: string } | null>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [event, host] = await Promise.all([get(event$), get(hostGrant$)]);
    const automation = event?.contextType === "automation";
    return {
      systemPromptVariables: {
        computerUseContext: host
          ? [
              "# Computer Use",
              `Computer Use is enabled for this run on ${host.displayName}.`,
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
