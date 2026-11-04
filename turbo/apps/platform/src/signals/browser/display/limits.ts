/** Captured and decoded image edges share one supported raster ceiling. */
export const maximumFrameDimension = 4096;

/** Captured and decoded images share one total pixel ceiling. */
export const maximumFrameArea = 3840 * 2160;

/** Base64 characters: 4K RGBA needs 42.1875 MiB before encoding overhead. */
export const maximumEncodedFrameLength = 48 * 1024 * 1024;

/** Bounded metadata and JSON envelope allowance beyond the image payload. */
export const maximumCdpMessageLength = maximumEncodedFrameLength + 1024 * 1024;
