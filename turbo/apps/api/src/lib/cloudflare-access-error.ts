export function cloudflareAccessErrorResponse<Status extends 400 | 404 | 409>(
  status: Status,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
