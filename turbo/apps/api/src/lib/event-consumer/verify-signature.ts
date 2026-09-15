import { isTimestampValid, verifyHmacSignature } from "./hmac";

interface VerifyResult {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Verify an incoming HMAC-signed callback or event-consumer request.
 */
export function verifyCallbackRequest(
  body: string,
  secret: string,
  signature: string | null,
  timestamp: string | null,
): VerifyResult {
  if (!signature) {
    return { valid: false, error: "Missing X-Okou-Signature header" };
  }
  if (!timestamp) {
    return { valid: false, error: "Missing X-Okou-Timestamp header" };
  }

  const timestampNum = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampNum)) {
    return { valid: false, error: "Invalid timestamp format" };
  }

  if (!isTimestampValid(timestampNum)) {
    return { valid: false, error: "Timestamp expired" };
  }

  if (!verifyHmacSignature(body, secret, timestampNum, signature)) {
    return { valid: false, error: "Invalid signature" };
  }

  return { valid: true };
}
