import type { ComponentPropsWithoutRef } from "react";
import { useGet, useSet } from "ccstate-react";
import { RailViewport as RailViewportPrimitive } from "@okouai/ui";
import { locale$ } from "../../signals/locale.ts";
import {
  bindRail$,
  commitRailContent$,
} from "../../signals/okou-page/rail-travel.ts";

/** The content owner requests geometry; the UI primitive receipts its DOM. */
export function RailViewport({
  contentRevision,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  readonly contentRevision: string;
}) {
  const locale = useGet(locale$);
  const bindRail = useSet(bindRail$);
  const commit = useSet(commitRailContent$);
  return (
    <RailViewportPrimitive
      {...props}
      contentRevision={JSON.stringify([locale, contentRevision])}
      onViewportMount={bindRail}
      onContentCommit={commit}
    />
  );
}
