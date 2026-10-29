/** Captured and decoded image edges share one supported raster ceiling. */
export const maximumFrameDimension = 4096;

/** Captured and decoded images share one total pixel ceiling. */
export const maximumFrameArea = 3840 * 2160;

/** Base64 character count, before decoding; not the binary image byte length. */
export const maximumEncodedFrameLength = 12 * 1024 * 1024;

/** Each image waiter owns its timer, even when their default budget is shared. */
export const frameTimeoutMs = 10_000;

/** Native adaptation product budgets, independent of screenshot preferences. */
export const maximumDisplayDimension = 4096;
export const maximumDisplayArea = 3840 * 2160;
