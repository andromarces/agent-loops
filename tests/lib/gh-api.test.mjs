import { describe, expect, it } from "vite-plus/test";
import {
  ghApiFailure,
  ghReadError,
  isCleanServerError,
  isTransportFailure,
} from "../../src/lib/gh-api.mjs";

const failed = (stderr, stdout = "") => ({ status: 1, stdout, stderr });

const DIAL_TIMEOUT =
  'Post "https://api.github.com/graphql": dial tcp 20.205.243.168:443: connect: operation timed out';

const CONNECTION_RESET =
  "read tcp 10.0.0.2:51234->20.205.243.168:443: read: connection reset by peer";

describe("isCleanServerError", () => {
  // Usefulness: the wait retries only a clean server error, so a 4xx or an unparseable reply must not match.
  it("accepts a retryable status with no stdout and refuses everything else", () => {
    expect(isCleanServerError(failed("HTTP 504: Gateway Timeout (https://x)"))).toBe(true);
    expect(isCleanServerError(failed("HTTP 404: Not Found (https://x)"))).toBe(false);
    expect(isCleanServerError(failed("HTTP 504: Gateway Timeout", "partial"))).toBe(false);
  });
});

describe("isTransportFailure", () => {
  // Usefulness: the wait retries a transport failure that carries no HTTP status.
  // A status line, a reply body, and an unknown failure text stay terminal (issue #1312).
  it("accepts a transport failure with no HTTP status and no reply body", () => {
    expect(isTransportFailure(failed(DIAL_TIMEOUT))).toBe(true);
    expect(isTransportFailure(failed(CONNECTION_RESET))).toBe(true);
  });

  it("refuses a text with an HTTP status, a reply body, or no known transport wording", () => {
    expect(
      isTransportFailure(failed(`HTTP 502: Bad Gateway (https://x): ${CONNECTION_RESET}`)),
    ).toBe(false);
    expect(isTransportFailure(failed(`gh: Not Found (HTTP 404): ${DIAL_TIMEOUT}`))).toBe(false);
    expect(isTransportFailure(failed(DIAL_TIMEOUT, '{"message":"connection reset by peer"}'))).toBe(
      false,
    );
    expect(isTransportFailure(failed("gh: the reply could not be parsed"))).toBe(false);
  });
});

describe("ghReadError", () => {
  // Usefulness: the error text and `transient` are what the wait reports and retries on.
  it("names the label and the failure, and sets transient for a server error or a transport failure", () => {
    const server = ghReadError("gh pr view 7", failed("HTTP 502: Bad Gateway (https://x)"));
    expect(server.message).toBe(
      "gh pr view 7 could not be read: HTTP 502: Bad Gateway (https://x)",
    );
    expect(server.transient).toBe(true);
    const transport = ghReadError("gh pr view 7", failed(DIAL_TIMEOUT));
    expect(transport.message).toBe(`gh pr view 7 could not be read: ${DIAL_TIMEOUT}`);
    expect(transport.transient).toBe(true);
    const other = ghReadError("gh pr view 7", failed("boom"));
    expect(other.message).toBe("gh pr view 7 could not be read: boom");
    expect(other.transient).toBeUndefined();
  });
});

describe("ghApiFailure", () => {
  // Usefulness: a source and commit read carries `transient` for a transport failure.
  // That holds with or without `--include`, and a reply that wrote a body stays terminal
  // (issue #1312).
  it("marks a transport failure transient with or without a reply body", () => {
    expect(ghApiFailure("repos/x", { ...failed(DIAL_TIMEOUT), include: true }).transient).toBe(
      true,
    );
    expect(ghApiFailure("repos/x", failed(DIAL_TIMEOUT)).transient).toBe(true);
    expect(
      ghApiFailure("repos/x", {
        ...failed(`gh: Forbidden (HTTP 403): ${CONNECTION_RESET}`),
        include: true,
      }).transient,
    ).toBeFalsy();
    expect(
      ghApiFailure("repos/x", {
        status: 1,
        stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{}",
        stderr: CONNECTION_RESET,
      }).transient,
    ).toBeFalsy();
  });
});
