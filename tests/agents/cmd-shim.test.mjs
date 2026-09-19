import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

// Usefulness: verifies the issue-#7 mechanism that a real Windows .cmd shim rejects multi-line argv but accepts the same prompt on stdin with the newline-free argv shapes the agents now use. The adapter tests mock execa, so only this test exercises a real .cmd spawn.
(process.platform === "win32" ? test : test.skip)(
  "windows .cmd shim rejects multi-line argv and round-trips stdin",
  async () => {
    const { execa: realExeca } = await vi.importActual("execa");
    const prompt =
      'Inspect both lines.\r\nKeep "quotes", %PATH%, & | < > and Unicode: café.\nLast line.';
    const dir = await mkdtemp(join(tmpdir(), "cmd-shim-"));
    const shim = join(dir, "echo-prompt.cmd");

    await writeFile(shim, '@echo off\r\nnode -e "process.stdin.pipe(process.stdout)"\r\n');

    try {
      expect(() => realExeca(shim, ["-p", prompt, "--output-format", "json"])).toThrow(
        /line break/,
      );

      for (const args of [
        ["-p", "--output-format", "json"],
        ["--input-format", "text", "--output-format", "json"],
      ]) {
        const result = await realExeca(shim, args, {
          input: prompt,
          stripFinalNewline: false,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(prompt);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
