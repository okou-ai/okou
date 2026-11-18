import { GetObjectCommand } from "@aws-sdk/client-s3";
import { onTestFinished } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { createDeferredPromise } from "../../../utils";

/** Hold the next download signature for a cold object the scenario published. */
export function holdDownloadSigning(context: TestContext) {
  const presigner = context.mocks.s3.getSignedUrl;
  const sign = presigner.getMockImplementation();
  if (!sign) {
    throw new Error("Expected the external presigner fixture");
  }
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const hold = async (...args: unknown[]) => {
    if (args[1] instanceof GetObjectCommand && !entered.settled()) {
      entered.resolve();
      await released.promise;
    }
    return await sign(...args);
  };
  const release = () => {
    if (presigner.getMockImplementation() === hold) {
      presigner.mockImplementation(sign);
    }
    if (!released.settled()) {
      released.resolve();
    }
  };
  onTestFinished(release);
  presigner.mockImplementation(hold);
  return { entered: entered.promise, release };
}
