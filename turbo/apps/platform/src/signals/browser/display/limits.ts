/** Captured and decoded image edges share one supported raster ceiling. */
export const maximumFrameDimension = 4096;

/** Captured and decoded images share one total pixel ceiling. */
export const maximumFrameArea = 3840 * 2160;

/** Base64 character count, before decoding; not the binary image byte length. */
export const maximumEncodedFrameLength = 12 * 1024 * 1024;
