import { enum as zEnum } from "zod";

export const computerUseHostStatusSchema = zEnum(["online", "offline"]);
