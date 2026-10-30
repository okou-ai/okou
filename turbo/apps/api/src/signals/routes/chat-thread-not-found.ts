import { notFound } from "../../lib/error";

export function chatThreadNotFound() {
  return notFound("Chat thread not found");
}
