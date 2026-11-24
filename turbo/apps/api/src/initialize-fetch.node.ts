// Undici 7 initializes a default dispatcher only when there isn't one already.
// Load Node's lazy Fetch module before Undici so native Fetch keeps its dispatcher.
void globalThis.Request;
