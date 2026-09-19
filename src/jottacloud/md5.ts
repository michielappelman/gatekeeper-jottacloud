/**
 * MD5 of an ArrayBuffer, hex-encoded. Jottacloud's allocate step and revision metadata are keyed on
 * MD5, which the standard Web Crypto `SubtleCrypto` does not implement — this
 * uses Node's `crypto` module instead, available under this Worker's `nodejs_compat` flag.
 */
import { createHash } from "node:crypto";

export function md5Hex(content: ArrayBuffer): string {
  return createHash("md5").update(new Uint8Array(content)).digest("hex");
}
