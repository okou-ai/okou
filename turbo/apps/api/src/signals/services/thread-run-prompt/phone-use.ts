import { computed, type Computed } from "ccstate";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
export function createPhoneUsePrompt(
  grant$: Computed<Promise<{ deviceId: string; grantId: string } | null>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
) {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const features = await get(featureSwitches$);
    const grant = await get(grant$);
    const enabled = isFeatureEnabled(FeatureSwitchKey.PhoneUse, features);
    return {
      systemPromptVariables: {
        phoneUseContext: enabled
          ? [
              "# Internal Phone Use",
              "Use `okou phone-use --help` to control the owner's iPhone through Okou iOS Use. The Agent runs here in the cloud; the phone must have a live owner-started control window.",
              grant
                ? "This Run captured a Phone Use grant. Run `start --goal` before input, observe the current app, use fresh snapshot IDs and element IDs, and stop at task completion."
                : "No phone is authorized for this Run. Ask the owner to open Okou iOS Use, sign in, select this chat and allow it. Start a new Run afterward; tokens cannot be upgraded in place.",
              "Only one Run controls the phone for a whole task. Always inspect operation IDs after a timeout or disconnect. Unknown effects must never be replayed. A native acknowledgement is not proof of the desired UI outcome; reobserve.",
              "The owner must handle unlock, secrets, verification codes and system authentication. Ordinary navigation, field focus, typing and vertical scrolling run automatically. Before any send, publish, payment, order, deletion, security change or other consequential commit, use tap/swipe --confirm with the exact consequence. Do not rely on button text alone; reason from the goal, app, screen and intended effect. Unknown controls may also require local confirmation. Never target the Use App's authorization, confirmation or Stop UI with automation. Never approve your own action.",
              "When an operation reports approval_required, tell the owner to review that exact action in Use, then run `okou phone-use wait <operationId>` to wait read-only for up to five minutes. Keep this originating Run alive while waiting; ending it revokes the pending approval. Do not resubmit the input or try to approve via automation. On expiry or lost authority, stop and report the handoff state.",
              "`stop` immediately closes this Run's server admission and cancels pending review. Its nativeAcknowledged:false receipt does not prove that the phone already stopped; an authorized in-flight effect may finish. Local Stop remains available on the phone. Start a new Run for another phone task after stop.",
              "Save screenshots with --output when visual inspection is needed. Phone evidence is private. Stop on locking, native expiry, ownership changes, missing authority or unexpected foreground UI.",
            ].join("\n")
          : "",
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
