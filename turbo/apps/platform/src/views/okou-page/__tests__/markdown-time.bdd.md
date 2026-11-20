# Markdown time

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-time.test.tsx](markdown-time.test.tsx).

## markdown-time-001

Original test `Markdown times use the browser timezone for each instant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-time.test.tsx#L24).

- **Given** A chat message contains one time with a +08:00 offset in September and another UTC time in January. The browser timezone is America/Los_Angeles, while the saved application timezone is Pacific/Auckland.
- **When** The chat message is rendered.
- **Then** Each instant is shown in Pacific Daylight or Standard Time respectively: Sep 9, 2026, 12:00:00 AM PDT and Jan 8, 2026, 11:00:00 PM PST. The original datetime values remain on the time elements, and the summer time remains bold.

## markdown-time-002

Original test `Markdown times follow the browser locale even when the application UI is in English`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-time.test.tsx#L55).

- **Given** A chat message contains a time with a +08:00 offset. The browser language is en-GB, another preferred language is zh-CN, and the application UI locale is en-US; the browser timezone is Asia/Shanghai.
- **When** The chat message is rendered.
- **Then** The time is displayed in the browser locale as “2026年9月9日 GMT+8 15:00:00,” with its original datetime value. The document language remains en-US.

## markdown-time-003

Original test `Missing, invalid, and timezone-free datetimes retain their original text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-time.test.tsx#L76).

- **Given** A chat message contains time tags with no datetime, an empty or invalid datetime, an invalid calendar date, a date-only value, a timezone-free datetime, and a duration value.
- **When** The chat message is rendered in the America/Los_Angeles timezone.
- **Then** Each time tag retains its original text, including “No datetime provided,” “Empty datetime,” “Invalid datetime,” “Invalid calendar date,” “Date only,” “No timezone offset,” and “Duration.”

## markdown-time-004

Original test `Time tags in inline and fenced code remain literal code`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-time.test.tsx#L110).

- **Given** A Markdown message contains time tags in inline code, fenced HTML code, and ordinary text.
- **When** The message is rendered in the America/Los_Angeles timezone.
- **Then** Only the ordinary time tag is rendered as a time, displayed as Sep 9, 2026, 12:00:00 AM PDT. The inline and fenced examples remain literal code.
