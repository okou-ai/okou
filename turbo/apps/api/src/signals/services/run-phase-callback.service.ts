import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, type Computed } from "ccstate";
import { runPhaseMarkEvent } from "../../lib/run-phase-mark";
import type { SandboxAuth } from "../../types/auth";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";
import { awaitWithSignal } from "../utils";
import { createUserFeatureSwitchContext } from "./feature-switches.service";

export function createRunPhaseCallback(
  identity$: Computed<Promise<SandboxAuth | null>>,
) {
  const features$ = createUserFeatureSwitchContext(identity$);
  const record$ = command(
    async ({ get }, receivedAt: Date, signal: AbortSignal) => {
      const identity = await awaitWithSignal(get(identity$), signal);
      signal.throwIfAborted();
      if (!identity) {
        return;
      }
      const features = await awaitWithSignal(get(features$), signal);
      signal.throwIfAborted();
      if (
        !features ||
        !isFeatureEnabled(
          FeatureSwitchKey.ArtifactGenerationTiming,
          features,
        ) ||
        !isFeatureEnabled(FeatureSwitchKey.ArtifactThreePointTiming, features)
      ) {
        return;
      }
      await ingestAxiomDirect(
        getDatasetName("web-logs"),
        [
          runPhaseMarkEvent(
            identity,
            { phase: "completion-callback" },
            receivedAt,
          ),
        ],
        signal,
      );
    },
  );
  return { record$ };
}
