import { reportBlock } from "./report.mjs";

export function reviewerPrompt(prompt) {
  return `
Do not implement, fix, edit, or change any file. Review, assess, and verify only. Live probes and read-only queries are authorized.

${reportBlock}

Instructions:
${prompt}
`.trim();
}
