import { describe, expect, it } from "vite-plus/test";
import {
  bodyClassOf,
  ghApi,
  ghApiFailure,
  ghReadError,
  isCleanServerError,
  isTransportFailure,
  pagedRead,
  readPrList,
} from "../../../src/lib/checks/gh-api.mjs";
import { boundedRunner } from "../../../src/lib/checks/bounded-call.mjs";

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
    // The Go client writes a bare EOF as a quoted URL followed by `: EOF` at the end.
    expect(isTransportFailure(failed('Get "https://api.github.com/graphql": EOF'))).toBe(true);
    expect(isTransportFailure(failed('Post "https://api.github.com/graphql": EOF'))).toBe(true);
  });

  // Usefulness: verifies a status line, a reply body, or unknown text stays terminal, so the wait
  // never retries a failure it cannot classify as a transport failure (issue #1312).
  it("refuses a text with an HTTP status, a reply body, or no known transport wording", () => {
    expect(
      isTransportFailure(failed(`HTTP 502: Bad Gateway (https://x): ${CONNECTION_RESET}`)),
    ).toBe(false);
    expect(isTransportFailure(failed(`gh: Not Found (HTTP 404): ${DIAL_TIMEOUT}`))).toBe(false);
    expect(isTransportFailure(failed(DIAL_TIMEOUT, '{"message":"connection reset by peer"}'))).toBe(
      false,
    );
    expect(isTransportFailure(failed("gh: the reply could not be parsed"))).toBe(false);
    // A bare EOF only counts in the shape of the Go client, a quoted URL plus `: EOF` at the end.
    expect(isTransportFailure(failed('Get "https://x": EOF and then more'))).toBe(false);
    expect(isTransportFailure(failed("gh: the reply mentions EOF"))).toBe(false);
    expect(
      isTransportFailure(failed('HTTP 404: Not Found (https://x): Get "https://x": EOF')),
    ).toBe(false);
    expect(
      isTransportFailure(
        failed("gh: the reply could not be parsed", '{"message":"Get \\"https://x\\": EOF"}'),
      ),
    ).toBe(false);
  });
});

describe("bodyClassOf", () => {
  // Usefulness: the class a failed 5xx read reports, and the retry rule, depend on telling a
  // truncated JSON value from a complete value followed by text (issue #1519).
  it("names the shape of a reply body without a byte of it", () => {
    expect(bodyClassOf("")).toBe("empty");
    expect(bodyClassOf('{"message":"x"}')).toBe("JSON");
    expect(bodyClassOf('{"message":"x"')).toBe("truncated JSON");
    expect(bodyClassOf('{"message":"x"\n')).toBe("truncated JSON");
    expect(bodyClassOf("[1,2")).toBe("truncated JSON");
    expect(bodyClassOf("{}\n{}")).toBe("unparseable JSON");
    expect(bodyClassOf('{"message":"x"}\ntrailing')).toBe("unparseable JSON");
    expect(bodyClassOf("<html></html>")).toBe("other text");
    expect(bodyClassOf("Bad Gateway")).toBe("other text");
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

describe("boundedRunner", () => {
  // Usefulness: a reply that ends after the caller aborts never reaches the caller as data.
  it("throws on a reply that ends after the caller abort, keeping the reason", async () => {
    const reason = new Error("the caller stopped");
    const controller = new AbortController();
    const gh = (args, cwd, options) =>
      new Promise((resolve) => {
        options.signal.addEventListener(
          "abort",
          () => resolve({ status: 0, stdout: "", stderr: "" }),
          { once: true },
        );
      });
    const call = boundedRunner(gh, 60_000, controller.signal);
    const pending = call(["pr", "view", "1"], ".");
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
  });

  // Usefulness: a cancel that fired before the deadline keeps its reason after a late reply.
  it("keeps a cancel that fired before the deadline", async () => {
    const reason = new Error("stopped before the deadline");
    const controller = new AbortController();
    const gh = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: 0, stdout: "", stderr: "" }), 60),
      );
    const call = boundedRunner(gh, 30, controller.signal);
    const pending = call(["pr", "view", "1"], ".");
    setTimeout(() => controller.abort(reason), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
  });

  // Usefulness: a deadline that fires first still reports the read timeout.
  it("reports a timeout when the deadline fires first", async () => {
    const gh = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: 0, stdout: "", stderr: "" }), 60),
      );
    const call = boundedRunner(gh, 20);
    await expect(call(["pr", "view", "1"], ".")).rejects.toMatchObject({ timedOut: true });
  });
});

describe("a successful reply that is not JSON", () => {
  const malformed = { status: 0, stdout: "{not json", stderr: "" };

  // Usefulness: a malformed reply keeps the SyntaxError class of a direct JSON.parse and names the
  // read, so a caller that classifies on the class sees the same error as before.
  it("throws a SyntaxError that names the read through ghApi and readPrList", async () => {
    const gh = async () => malformed;
    const api = ghApi(gh, ["repos/o/r/commits"], ".");
    await expect(api).rejects.toBeInstanceOf(SyntaxError);
    await expect(api).rejects.toThrow(/gh api repos\/o\/r\/commits returned invalid JSON/);

    const read = async () => malformed;
    const list = readPrList(read, ["pr", "list"], () => true);
    await expect(list).rejects.toBeInstanceOf(SyntaxError);
    await expect(list).rejects.toThrow(/gh pr list returned invalid JSON/);
  });
});

describe("paged read host", () => {
  const files = (count, from = 0) =>
    Array.from({ length: count }, (_, index) => ({ filename: `f${from + index}.mjs` }));

  /** One page reply, with a \`Link\` header on the host \`linkHost\` when it is given. */
  const pageReply = (items, linkHost = null) => ({
    status: 0,
    stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${
      linkHost === null
        ? ""
        : `Link: <https://${linkHost}/api/v3/repos/o/r/pulls/1/files?per_page=100&page=2>; rel="next"\r\n`
    }\r\n${JSON.stringify(items)}`,
    stderr: "",
  });

  /**
   * A gh double that appends \`--hostname ghe.example.com\` to every api call, serves two pages, and
   * answers the auth lookup that the current pager makes for its default host.
   */
  function hostGh(linkHost) {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "auth") {
        return {
          status: 0,
          stdout: JSON.stringify({
            hosts: { "github.com": [{ host: "github.com", tokenSource: "hosts.yml" }] },
          }),
          stderr: "",
        };
      }
      const page = Number(/page=(\d+)$/.exec(args[1] ?? "")?.[1]);
      return page === 1 ? pageReply(files(100), linkHost) : pageReply(files(1, 100));
    };
    const api = (args, cwd, options) =>
      args[0] === "api"
        ? gh([...args, "--hostname", "ghe.example.com"], cwd, options)
        : gh(args, cwd, options);
    return { api, calls };
  }

  // Usefulness: a page read sent to an enterprise host accepts a Link target on that host, so a pull
  // request with more than 100 files is not refused by the gh default host.
  it("accepts a Link target on the host named by --hostname", async () => {
    const { api, calls } = hostGh("ghe.example.com");
    const pages = await ghApi(
      pagedRead(api, null, "ghe.example.com"),
      ["repos/o/r/pulls/1/files"],
      "/repo",
    );
    expect(pages.flat()).toHaveLength(101);
    expect(calls.some((call) => call.startsWith("auth "))).toBe(false);
  });

  // Usefulness: every other host is still refused when the request names its host, so a steered page
  // never widens the accepted hosts.
  it("refuses a Link target on another host when --hostname names one", async () => {
    const { api } = hostGh("other.example");
    await expect(
      ghApi(pagedRead(api, null, "ghe.example.com"), ["repos/o/r/pulls/1/files"], "/repo"),
    ).rejects.toThrow(/Link/);
  });
});
