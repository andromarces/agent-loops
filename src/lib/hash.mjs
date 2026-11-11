import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest. Accepts a string (hashed as UTF-8) or a Buffer, so text
 * and file bytes hash through one helper.
 */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `value` is a lowercase SHA-256 hex digest. */
export function isSha256Hex(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}
