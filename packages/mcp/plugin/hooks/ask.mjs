#!/usr/bin/env node
// PreToolUse hook: every JOMO tool that moves funds or writes on chain is approved by the user in
// Claude Code's own prompt, even if it was added to an auto-allow list. The one exception is an
// operator who chose autonomous mode (JOMO_CONFIRM=auto): then the server's spending limits decide,
// and anything outside them is asked of the user or refused by the server itself.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  if ((process.env.JOMO_CONFIRM ?? "").toLowerCase() === "auto") return; // no opinion: the server's limits apply
  let tool = "a JOMO tool";
  try {
    tool = JSON.parse(input).tool_name ?? tool;
  } catch {
    /* no input: still ask */
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `${tool} moves funds or writes on chain. Read the summary and approve it yourself (or run JOMO in autonomous mode with spending limits).`,
      },
    }),
  );
});
