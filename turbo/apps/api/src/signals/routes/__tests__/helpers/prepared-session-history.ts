import type { TestContext } from "../../../../__tests__/test-context";

export function captureSessionStorageMocks(context: TestContext) {
  const send = context.mocks.s3.send.getMockImplementation();
  const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
  return () => {
    if (send) {
      context.mocks.s3.send.mockImplementation(send);
    } else {
      context.mocks.s3.send.mockReset();
    }
    if (sign) {
      context.mocks.s3.getSignedUrl.mockImplementation(sign);
    } else {
      context.mocks.s3.getSignedUrl.mockReset();
    }
  };
}
