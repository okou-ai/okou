import { onTestFinished } from "vitest";

import {
  clearUserConnectorMutationHooksForTest,
  setUserConnectorMutationHooksForTest,
} from "../signals/services/user-connectors.service";

export function holdUserConnectorMutationBeforeAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setUserConnectorMutationHooksForTest({ beforeAdmission: hold });
  onTestFinished(() => {
    clearUserConnectorMutationHooksForTest();
  });
}
