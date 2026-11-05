/** Optional native acceleration, described for Platform's ES2022 libs. */
export interface BrowserByteArrayConstructor extends Uint8ArrayConstructor {
  fromBase64?(value: string): Uint8Array<ArrayBuffer>;
}
