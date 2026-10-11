/**
 * Replaces U+0085, U+2028, and U+2029 with a visible `\uXXXX` escape. A model or a renderer can
 * read these characters as a line break, and `JSON.stringify` leaves them raw, so untrusted text
 * could start what reads as a new line. Every prompt builder applies this once to its final text
 * (issue #761). A JSON document stays valid and decodes to the same value, because the characters
 * only occur inside strings.
 * @param {string} text
 * @returns {string}
 */
export const escapeLineSeparators = (text) =>
  text.replace(
    /[\u{85}\u{2028}\u{2029}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
