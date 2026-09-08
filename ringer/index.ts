import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode === "tui" && ctx.isIdle() && process.stderr.isTTY) {
      process.stderr.write("\x07");
    }
  });
}
