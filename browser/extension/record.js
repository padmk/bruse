/**
 * Whether a value that arrived from outside (parsed JSON from the hub, a request's parameters) is an
 * object, whose fields can then be read; each field is still unknown until checked.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null;
}
