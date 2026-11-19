import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { runPhaseMarkEvent } from "../../lib/run-phase-mark";
import type { SandboxAuth } from "../../types/auth";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";
import { awaitWithSignal } from "../utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

export function createRunPhaseCallback(identity: SandboxAuth) {
  const features$ = userFeatureSwitchContext(identity.orgId, identity.userId);
  const record$ = command(
    async ({ get }, receivedAt: Date, signal: AbortSignal) => {
      const features = await awaitWithSignal(get(features$), signal);
      signal.throwIfAborted();
      if (
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
