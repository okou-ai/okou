import { cn } from "@okouai/ui";

// Literal white keeps paper white in Dark, where the white token is theme-flipped.
const DOCUMENT_SHEET =
  "absolute left-1/2 top-[8%] ml-[-30.5%] aspect-[210/297] w-[61%] " +
  "overflow-hidden rounded-[2px] bg-[#ffffff] " +
  "shadow-[0_1px_2px_hsl(220_12%_50%/0.16),0_7px_18px_hsl(220_12%_50%/0.07)]";

/**
 * A document template's cover: the source's first page, over the sheets that
 * say it had more.
 *
 * Drawn larger than the tile and cropped by its bottom edge rather than fitted
 * inside it. A whole page scaled into this tile puts its title at about five
 * pixels — below what any script reads at — so fitting it buys a smaller
 * smudge, not a legible one. What the crop keeps is the head of the page,
 * where the format lives: how many columns, how much white space, whether it
 * opens with a masthead or a row of form fields. The title is the line
 * underneath the tile, and stays there.
 *
 * The sheets behind indicate a multipage document. They are not additional
 * page previews; the detail view owns those images.
 */
export function DocumentTemplateCover({
  hasMorePages,
  coverUrl,
  onError,
}: {
  readonly hasMorePages: boolean;
  readonly coverUrl: string;
  readonly onError?: () => void;
}) {
  return (
    <>
      {hasMorePages ? (
        <>
          <span
            data-testid="document-cover-sheet"
            className={cn(
              DOCUMENT_SHEET,
              "translate-x-[6.4%] translate-y-[3.8%]",
            )}
          />
          <span
            data-testid="document-cover-sheet"
            className={cn(
              DOCUMENT_SHEET,
              "translate-x-[3.2%] translate-y-[1.9%]",
            )}
          />
        </>
      ) : null}
      {/* No z-index: the sheets are positioned siblings at `z-index: auto`, so
          tree order already paints this one over them. */}
      <span className={DOCUMENT_SHEET}>
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          onError={onError}
          data-testid="document-cover-page"
          className="h-full w-full object-cover object-top"
        />
      </span>
    </>
  );
}
