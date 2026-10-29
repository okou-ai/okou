/** Required native API, described locally for Platform using ES2022 libs. */
export interface BrowserByteArrayConstructor extends Uint8ArrayConstructor {
  fromBase64(value: string): Uint8Array<ArrayBuffer>;
}
