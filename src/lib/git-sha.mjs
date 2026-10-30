// A full object name, so two heads compare by equality. `gh` reports SHA-1 and SHA-256 names.
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `value` is a full lowercase commit SHA, the form a `--head` and a read head carry. */
export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}
