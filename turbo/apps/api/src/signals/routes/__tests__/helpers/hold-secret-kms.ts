import { createDeferredPromise } from "../../../utils";
import { useSecretKmsProbe } from "./secret-kms-probe";
import { onTestFinished } from "vitest";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../../lib/secret-kms-client";

/** Pause new preparation without replacing keys used by existing credentials. */
export function holdCurrentSecretKms(signal: AbortSignal) {
  const client = getSecretKmsClient();
  const entered = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  const release = () => {
    if (!released.settled()) {
      released.resolve();
    }
  };
  setSecretKmsClientForTests({
    ...client,
    async generateDataKey(request, operationSignal) {
      if (!entered.settled()) {
        entered.resolve();
      }
      await released.promise;
      return await client.generateDataKey(request, operationSignal);
    },
  });
  onTestFinished(() => {
    release();
    setSecretKmsClientForTests(client);
  });
  return { entered: entered.promise, release };
}

export function holdSecretKms(callToHold: number, signal: AbortSignal) {
  const entered = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  useSecretKmsProbe((request, callNumber) => {
    if (callNumber !== callToHold) {
      return undefined;
    }
    return (async () => {
      entered.resolve();
      await released.promise;
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
        encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
      };
    })();
  });
  return {
    entered: entered.promise,
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
  };
}
