import { describe, expect, it } from "vite-plus/test";
import { ghReadError, isCleanServerError } from "../../src/lib/gh-api.mjs";

const failed = (stderr, stdout = "") => ({ status: 1, stdout, stderr });

describe("isCleanServerError", () => {
  // Usefulness: the wait retries only a clean server error, so a 4xx or an unparseable reply must not match.
  it("accepts a retryable status with no stdout and refuses everything else", () => {
    expect(isCleanServerError(failed("HTTP 504: Gateway Timeout (https://x)"))).toBe(true);
    expect(isCleanServerError(failed("HTTP 404: Not Found (https://x)"))).toBe(false);
    expect(isCleanServerError(failed("HTTP 504: Gateway Timeout", "partial"))).toBe(false);
  });
});

describe("ghReadError", () => {
  // Usefulness: the error text and `transient` are what the wait reports and retries on.
  it("names the label and the failure, and sets transient only for a clean server error", () => {
    const server = ghReadError("gh pr view 7", failed("HTTP 502: Bad Gateway (https://x)"));
    expect(server.message).toBe(
      "gh pr view 7 could not be read: HTTP 502: Bad Gateway (https://x)",
    );
    expect(server.transient).toBe(true);
    const other = ghReadError("gh pr view 7", failed("boom"));
    expect(other.message).toBe("gh pr view 7 could not be read: boom");
    expect(other.transient).toBeUndefined();
  });
});
