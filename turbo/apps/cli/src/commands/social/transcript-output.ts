import { escapeText } from "entities/escape";
import { z } from "zod";

const transcriptSchema = z.object({
  transcript: z.string().optional(),
  transcriptSegments: z.array(z.unknown()).optional(),
  language: z.string().optional(),
});
const textSegmentSchema = z.object({ text: z.string() });
const timedSegmentSchema = textSegmentSchema.extend({
  start: z.number().nonnegative(),
  duration: z.number().positive(),
});

function plainText(data: z.infer<typeof transcriptSchema>): string {
  if (data.transcript?.trim()) return data.transcript;
  const text = (data.transcriptSegments ?? [])
    .map((segment, index) => {
      const parsed = textSegmentSchema.safeParse(segment);
      if (!parsed.success) {
        throw new Error(`Transcript segment ${index + 1} has no valid text`);
      }
      return parsed.data.text;
    })
    .join("\n");
  if (!text.trim())
    throw new Error("No transcript text is available in this result");
  return text;
}

function subtitleError(message: string): never {
  throw new Error(
    `${message}. Use --format text for plain-text export; after this failure, save data.transcript or join data.transcriptSegments[].text from the recovered stdout JSON without repeating the Social request`,
  );
}

function timestamp(milliseconds: number, separator: "," | "."): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return (
    [hours, minutes, seconds]
      .map((part) => {
        return String(part).padStart(2, "0");
      })
      .join(":") +
    separator +
    String(milliseconds % 1_000).padStart(3, "0")
  );
}

function subtitles(
  segments: readonly unknown[] | undefined,
  format: "srt" | "vtt",
): string {
  if (!segments?.length)
    subtitleError("No timed transcript segments are available");
  let previousStart = 0;
  const cues = segments.map((segment, index) => {
    const parsed = timedSegmentSchema.safeParse(segment);
    if (!parsed.success) {
      subtitleError(
        `Segment ${index + 1} requires text, a finite nonnegative start, and a finite positive duration in seconds`,
      );
    }
    const { text, start, duration } = parsed.data;
    if (!text.trim() || text.includes("\0")) {
      subtitleError(
        `Segment ${index + 1} requires nonblank text without NUL characters`,
      );
    }
    if (start < previousStart) {
      subtitleError(`Segment ${index + 1} starts before the preceding segment`);
    }
    previousStart = start;
    const startMs = Math.round(start * 1_000);
    const endMs = Math.round((start + duration) * 1_000);
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      endMs <= startMs
    ) {
      subtitleError(
        `Segment ${index + 1} has timing outside safe millisecond precision or an interval that rounds to zero`,
      );
    }
    const lines = text
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .filter((line) => {
        return line.trim().length > 0;
      });
    // SRT readers can recognize timing lines even without a blank cue separator.
    if (
      format === "srt" &&
      lines.some((line) => {
        return /^\s*[+-]?\d+:\s*[+-]?\d+:\s*[+-]?\d+[,.]\s*[+-]?\d+\s*-->/u.test(
          line,
        );
      })
    ) {
      subtitleError(
        `Segment ${index + 1} contains a timestamp-like line that SRT readers can interpret as another cue; choose --format vtt for literal timing text`,
      );
    }
    let cueText = lines.join("\n");
    if (format === "vtt") {
      // This encoder uses WebVTT-supported references and leaves quotes intact.
      cueText = escapeText(cueText);
    }
    const separator = format === "srt" ? "," : ".";
    return `${index + 1}\n${timestamp(startMs, separator)} --> ${timestamp(endMs, separator)}\n${cueText}\n\n`;
  });
  return (format === "vtt" ? "WEBVTT\n\n" : "") + cues.join("");
}

export function formatTranscript(
  value: unknown,
  format: "text" | "srt" | "vtt",
): { readonly contents: string; readonly language?: string } {
  const parsed = transcriptSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("The retrieved result has invalid transcript data");
  const contents =
    format === "text"
      ? plainText(parsed.data)
      : subtitles(parsed.data.transcriptSegments, format);
  return {
    contents: contents.endsWith("\n") ? contents : `${contents}\n`,
    ...(parsed.data.language === undefined
      ? {}
      : { language: parsed.data.language }),
  };
}
