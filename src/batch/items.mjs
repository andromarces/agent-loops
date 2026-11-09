// Item identity of a batch (adr/0121-mix-issue-pull-request-and-task-items-in-one-batch.md).
// An issue keeps its number as identity, so an issue-only batch stores the same names as before.
// A pull request and a free-text task use a prefixed string, which is also a safe path segment.

/** The loop modes of one item, the same values as the single-task `--mode`. */
export const ITEM_MODES = new Set(["work-first", "review-first", "review-only"]);
export const ITEM_KINDS = new Set(["issue", "pr", "task"]);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The default mode of one kind. */
export function defaultMode(kind) {
  return kind === "pr" ? "review-first" : "work-first";
}

/** The stable identity of one item, across start and resume. */
export function itemKey(kind, { number = null, id = null } = {}) {
  if (kind === "issue") return number;
  if (kind === "pr") return `pr-${number}`;
  if (kind === "task") return `task-${id}`;
  return null;
}

/** The work-tree, branch, transcript, and log segment of one identity. */
export function loopSegment(key) {
  return typeof key === "number" ? `issue-${key}` : key;
}

const positiveNumber = (value) => Number.isSafeInteger(value) && value >= 1;
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Normalizes one `--items-file` entry. Throws an Error whose message states the malformed field;
 * the caller marks it as a usage error.
 */
export function normalizeItem(raw, index) {
  const at = `Item ${index + 1}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at} is not a JSON object.`);
  }
  if (!ITEM_KINDS.has(raw.kind)) {
    throw new Error(`${at} names an unknown kind: ${raw.kind ?? "none"}.`);
  }
  if (raw.mode !== undefined && raw.mode !== null && !ITEM_MODES.has(raw.mode)) {
    throw new Error(`${at} names an unknown mode: ${raw.mode}.`);
  }
  if (raw.task !== undefined && raw.task !== null && !nonEmpty(raw.task)) {
    throw new Error(`${at} names an empty task text.`);
  }
  const mode = raw.mode ?? defaultMode(raw.kind);
  if (raw.kind === "issue" || raw.kind === "pr") {
    if (!positiveNumber(raw.number)) {
      throw new Error(`${at} names no ${raw.kind === "pr" ? "pull request" : "issue"} number.`);
    }
    return {
      kind: raw.kind,
      number: raw.number,
      key: itemKey(raw.kind, { number: raw.number }),
      mode,
      task: raw.task ?? null,
    };
  }
  if (raw.number !== undefined && raw.number !== null) {
    throw new Error(`${at} is a task with a number.`);
  }
  if (!nonEmpty(raw.text)) throw new Error(`${at} names no task text.`);
  if (!nonEmpty(raw.id)) throw new Error(`${at} requires an id.`);
  if (!TASK_ID.test(raw.id)) throw new Error(`${at} names a malformed id: ${raw.id}.`);
  return {
    kind: "task",
    text: raw.text,
    id: raw.id,
    key: itemKey("task", { id: raw.id }),
    mode,
    task: raw.task ?? null,
  };
}

/**
 * Normalizes a whole item list and refuses a duplicate identity. Returns the items in launch
 * order.
 */
export function normalizeItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("The items file must hold a non-empty JSON list.");
  }
  const items = raw.map((entry, index) => normalizeItem(entry, index));
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.key)) throw new Error(`The items list repeats the identity ${item.key}.`);
    seen.add(item.key);
  }
  return items;
}

/** The item of a prepared option set, or the legacy issue list as issue items. */
export function preparedItems(prepared) {
  if (Array.isArray(prepared.items) && prepared.items.length > 0) return prepared.items;
  return (prepared.issues ?? []).map((number) => ({
    kind: "issue",
    number,
    key: number,
    mode: "work-first",
    task: null,
  }));
}

/** The item stored in one loop checkpoint. */
export function loopItem(loop) {
  return {
    kind: loop.kind ?? "issue",
    number: loop.number ?? (typeof loop.issue === "number" ? loop.issue : null),
    key: loop.issue,
    mode: loop.mode ?? "work-first",
    task: loop.task ?? null,
  };
}
