import { decodeSandboxTokenPayload } from "./sandbox-token.js";
import { getOkouToken } from "../okou-env.js";

export async function getToken(): Promise<string | undefined> {
  return getOkouToken();
}

/**
 * Get the active token for API requests.
 * Runs use OKOU_TOKEN.
 */
export async function getActiveToken(): Promise<string | undefined> {
  return getToken();
}

export async function getApiUrl(): Promise<string> {
  const apiUrl = process.env.OKOU_API_BACKEND_URL;
  if (apiUrl) {
    // Add protocol if missing
    return apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`;
  }
  return "https://api.okou.ai";
}

export { decodeSandboxTokenPayload };

/**
 * Get the active organization for API requests.
 * The organization is carried by the Run token.
 */
export async function getActiveOrg(): Promise<string | undefined> {
  return decodeSandboxTokenPayload()?.orgId;
}
