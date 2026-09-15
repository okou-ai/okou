# Media worker

A stateless HTTP service that samples one poster frame from a video. It holds no
queue and no database: the API calls it the same way it already calls Cloudflare
Browser Rendering for HTML previews, and owns every retry decision.

## Endpoints

- `GET /health` reports liveness and the built revision.
- `POST /poster` with `{"sourceUrl": "https://..."}` returns `image/png`, or a
  JSON `{"code": ...}` body on failure.

Both require `Authorization: Bearer $MEDIA_WORKER_SECRET`. The secret is the only
trust boundary: the service fetches whatever URL an authenticated caller sends,
so it must stay reachable only from the API.

| Code                | Status | Meaning                                             |
| ------------------- | ------ | --------------------------------------------------- |
| `invalid_request`   | 400    | Malformed body or a non-HTTP(S) source URL          |
| `unauthorized`      | 401    | Wrong or missing secret                             |
| `unsupported_media` | 422    | No decodable video stream, or an out-of-range frame |
| `invalid_media`     | 422    | Probe output was not usable                         |
| `decode_failed`     | 422    | FFmpeg could not read or decode the source          |
| `render_failed`     | 500    | The service itself failed                           |
| `busy`              | 503    | Concurrency limit reached                           |
| `timeout`           | 504    | The render exceeded its deadline                    |

4xx codes describe the input, so re-rendering the same video cannot change them.
The API does not branch on the code: any non-200 leaves the video without a
poster until a later cron tick retries it.

## Rendering

FFmpeg reads the source over HTTP range requests and stops as soon as it has the
frame, so the transfer is a few megabytes regardless of the video's size. Measured
on a 470 MB MP4: 4.7 MB read for a moov-at-front file and 3.4 MB for moov-at-end,
about one second each. There is no full download, no local copy of the video, and
no size limit beyond the decoder's frame bounds.

The frame displayed at video-relative one second is sampled with rounding up, so
variable-frame-rate media keeps the frame covering that instant and a non-zero
start PTS is normalized first. A video shorter than one second falls back to its
last frame. Output is PNG, longest edge at most 640 pixels, display aspect ratio
preserved, at most 2 MiB. VP8/VP9 WebM alpha is retained by selecting `libvpx` or
`libvpx-vp9` explicitly; the default probe reports `yuv420p` and silently drops it.

Decoding is bounded by a 15 second probe deadline, a 60 second render deadline,
single-threaded FFmpeg, 8192 pixels per dimension, and 16,777,216 pixels per
frame. A poster frame never re-encodes the video or touches the original bytes.

## Configuration

| Variable                          | Required | Default | Purpose                         |
| --------------------------------- | -------- | ------- | ------------------------------- |
| `MEDIA_WORKER_SECRET`             | yes      |         | Shared bearer secret, ≥32 chars |
| `PORT`                            | no       | `8080`  | Listen port                     |
| `MEDIA_WORKER_MAX_CONCURRENCY`    | no       | `2`     | In-flight renders before `busy` |
| `MEDIA_WORKER_REQUEST_TIMEOUT_MS` | no       | `90000` | Whole-request deadline          |

Startup verifies that the image's FFmpeg exposes `libvpx`, `libvpx-vp9`, a PNG
encoder, and the `https` protocol, so a broken image fails to boot instead of
failing every request. Scratch files live in the container's temporary directory
and are removed per request; no persistent volume is needed.

## Deployment

Build with `docker build --build-arg GIT_COMMIT_SHA="$SHA" -f turbo/apps/media-worker/Dockerfile .`
from the repository root. Deploy it on a private network, set the same
`MEDIA_WORKER_SECRET` on the API as `MEDIA_WORKER_SECRET` plus `MEDIA_WORKER_URL`
pointing at this service, then enable `artifactVideoPosterFfmpeg` for the target
organization. With the switch off, or with the service unset, the API keeps using
the existing Cloudflare media transformation.
