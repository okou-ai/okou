import { discriminatedUnion, literal, object, uuid } from "zod";

export const artifactShareTargetSchema = discriminatedUnion("kind", [
  object({ kind: literal("file"), id: uuid() }),
  object({ kind: literal("html"), id: uuid() }),
]);
