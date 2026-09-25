import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest. Accepts a string (hashed as UTF-8) or a Buffer, so text
 * and file bytes hash through one helper.
 */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
