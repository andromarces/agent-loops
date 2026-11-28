/**
 * Returns the parent instruction sentences for a harness entry point, in order.
 * The caller joins them, because each harness has its own prompt constraints.
 */
export function parentInstructionParts({ harnessName, instructionsPath, sessionId, task }) {
  return [
    `Read \`${instructionsPath}\` and follow it for this request.`,
    "The task and role settings are:",
    task,
    `This ${harnessName} session id is \`${sessionId}\`. Pass it as \`--parent-session\` on the \`role\` init dispatch call. A batch request runs one \`batch start\` command, which takes no \`--parent-session\`; pass no session id there.`,
  ];
}
