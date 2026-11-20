import { useGet } from "ccstate-react";
import { assistantName$ } from "../../signals/branding.ts";

export function PwaChatTitle() {
  const name = useGet(assistantName$);

  return <span className="px-2 text-base font-semibold">{name}</span>;
}
