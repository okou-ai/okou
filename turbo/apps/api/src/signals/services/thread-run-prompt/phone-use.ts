import { computed, type Computed } from "ccstate";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RunPrompt } from "../run-prompt-and-skills";
export function createPhoneUsePrompt(
  grant$: Computed<Promise<{ deviceId: string; grantId: string } | null>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
) {
  return computed(async (get): Promise<RunPrompt> => {
    const features = await get(featureSwitches$);
    const grant = await get(grant$);
    const enabled = isFeatureEnabled(FeatureSwitchKey.PhoneUse, features);
    return {
      systemPromptVariables: {
        phoneUseContext: enabled
          ? [
              "# Internal Phone Use",
              "Use `okou phone-use --help` to control the owner's iPhone through Okou iOS Use. The Agent runs here in the cloud. `devices` reports online only when the phone is connected and control is available. If offline, ask the owner to open Use and go online; the phone does not select a chat or task goal.",
              grant
                ? "This Run captured a Phone Use grant. Run `start --goal`, observe the current foreground UI, and open the app requested by the task. Use can observe its own App, the Home screen and alerts. Observe before every tap, type or swipe, use fresh snapshot IDs and element IDs, and stop at task completion."
                : "No phone is authorized for this Run. Ask the owner to turn on their online iPhone in this Web Chat's Connectors menu. Start a new Run after authorization; tokens cannot be upgraded in place.",
              "Only one Run controls the phone for a whole task. Always inspect operation IDs after a timeout or disconnect. Unknown effects must never be replayed. A native acknowledgement is not proof of the desired UI outcome; reobserve.",
              "The companion executes authorized app, tap, type and swipe operations without classifying screens, button labels or gestures or requesting a second local action approval. Follow the task's authorization and the Agent's applicable confirmation rules for consequential actions. The owner must handle unlock, secrets, verification codes and system authentication.",
              "Use `status` or `wait <operationId>` to read an existing receipt without resubmitting input. An approval_required receipt comes from an older companion; stop and ask the owner to update Use. If an older Agent explicitly requests local confirmation and the companion rejects it as unavailable, update the Agent instructions, reobserve and reassess the action before issuing new input.",
              "`stop` immediately closes this Run's server admission. Its nativeAcknowledged:false receipt does not prove that the phone already stopped; an authorized in-flight effect may finish. Go offline remains available on the phone. Task completion keeps the device online for other authorized chats. Start a new Run for another phone task after stop.",
              "Save screenshots with --output when visual inspection is needed. Phone evidence is private. Stop on locking, native expiry, ownership changes, missing authority or an unsupported native operation. Reobserve when the foreground UI changes.",
            ].join("\n")
          : "",
      },
      userPromptVariables: {},
    };
  });
}
