import { Command } from "commander";
import { uploadWebFile } from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createArtifactPresentation } from "../shared/artifact-return";

interface UploadFileOptions {
  readonly file: string;
  readonly contentType?: string;
  readonly json?: boolean;
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a local file and print artifact presentation context")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .option("--content-type <mime>", "Override inferred content type")
  .option("--json", "Output metadata and Markdown return forms as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:           okou web upload-file -f /tmp/report.pdf
  Override content-type:   okou web upload-file -f /tmp/data --content-type text/csv
  Machine-readable output: okou web upload-file -f /tmp/report.pdf --json

Output:
  By default, prints artifact presentation context with inline-link and rich-preview Markdown forms.
  With --json, prints metadata plus inlineMarkdownLink, previewMarkdownBlock, and artifactPresentationContext.

Notes:
  - Authenticates via OKOU_TOKEN (requires file:write capability)
  - Persist the returned stable URL in chat messages
  - Private file URLs require the owner's authentication; they do not grant public access
  - Use okou web download-file <id> to retrieve a private file
  - Max file size: 1 GB
  - Markdown, TXT, CSV and TSV files use UTF-8 unless --content-type declares a charset
  - Allowed image types: png / jpeg / gif / webp / avif / svg / bmp / heic / heif / tiff / psd
  - Allowed video types: mp4 / webm / mov
  - Allowed audio types: aac / flac / m4a / mp3 / mp4 / mpga / ogg / opus / wav / webm
  - Allowed document/text types: pdf / txt / csv / tsv / md / html / json / xml / yaml / doc(x/m) / xls(x/m/b) / ppt(x/m) / odt / ods / odp / rtf
  - Allowed archive/data/design types: zip / rar / 7z / tar / gz / tgz / bz2 / xz / pages / numbers / key / parquet / sqlite / epub / ai
  - Use --content-type for ambiguous extensions like .mp4 or .webm when needed`,
  )
  .action(
    withErrorHandler(async (options: UploadFileOptions) => {
      const result = await uploadWebFile(options.file, {
        contentType: options.contentType,
        purpose: "artifact",
      });
      const presentation = createArtifactPresentation(
        result.filename,
        result.url,
      );
      if (options.json) {
        console.log(JSON.stringify({ ...result, ...presentation.json }));
        return;
      }
      console.log(
        [
          "The artifact upload completed successfully.",
          "",
          presentation.text,
        ].join("\n"),
      );
    }),
  );
