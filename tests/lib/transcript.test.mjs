import { expect, test, vi } from "vite-plus/test";

vi.mock("../../src/lib/atomic-write.mjs", async (importActual) => ({
  ...(await importActual()),
  writeFileAtomic: vi.fn(),
}));

import { writeFileAtomic } from "../../src/lib/atomic-write.mjs";
import { createTranscriptWriter } from "../../src/lib/transcript.mjs";

const writer = () =>
  createTranscriptWriter({
    options: { transcript: "/transcript.json", testCmd: null, compareHead: null, mode: null },
    roles: {},
    events: [],
    reviewerSandbox: null,
  });

// Usefulness: verifies a transcript write warning converts any thrown message safely, so a Symbol
// or an unconvertible string never escapes the handler (issue #431 warning path).
test.each([
  ["a Symbol message", Symbol("write failed")],
  [
    "a message whose string conversion throws",
    {
      toString() {
        throw new Error("no text");
      },
    },
  ],
])("a transcript write warning survives %s", async (_name, message) => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    writeFileAtomic.mockRejectedValueOnce(Object.assign(new Error("write failed"), { message }));

    await expect(writer().writeTranscript()).resolves.toBeUndefined();

    expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Failed to write transcript",
    );
  } finally {
    errorSpy.mockRestore();
  }
});
