import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";

type WeatherOperation =
  | "current"
  | "forecast/hourly"
  | "forecast/daily"
  | "history/hourly"
  | "air-quality/current";

export interface WeatherResponse {
  readonly operation?: string;
  readonly provider?: string;
  readonly attribution?: string;
  readonly creditsCharged?: number | null;
  readonly billingCategory?: string;
  readonly billingQuantity?: number;
  readonly result?: unknown;
}

function authenticatedJsonHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseErrorBody(
  response: Response,
): Promise<{ message: string; code: string }> {
  let message = `Okou Weather request failed (HTTP ${response.status})`;
  let code = response.status === 404 ? "NOT_FOUND" : "UNKNOWN";

  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.message === "string") {
        message = body.error.message;
      }
      if (typeof body.error.code === "string") {
        code = body.error.code;
      }
    }
  } catch {
    // Keep the status-based fallback when the response is not JSON.
  }

  if (response.status === 404 && code === "NOT_FOUND") {
    message =
      "Okou Weather API is not available on this server yet. Try again after the weather backend is deployed.";
  }

  return { message, code };
}

export async function callWeather(
  operation: WeatherOperation,
  body: Record<string, unknown>,
): Promise<WeatherResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const response = await fetch(new URL(`/api/weather/${operation}`, baseUrl), {
    method: "POST",
    headers: headersWithCliClientHeaders(authenticatedJsonHeaders(token)),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const { message, code } = await parseErrorBody(response);
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as WeatherResponse;
}
