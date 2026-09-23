/**
 * dispatcher.ts — Pi extension: Glitch sub-agent dispatcher (Plan 2 §5.2)
 *
 * Registers a `task` tool (OpenCode-compatible name) so routing.ts can track
 * dispatches and the review gate works. Agents are discovered from:
 *   - project: .pi/agents/*.md   (Glitch's 10 defs)
 *   - user:    ~/.pi/agent/agents/*.md
 *
 * Spawn strategy (Plan 2 §5.2 ranking):
 *   1. Pi SDK (createAgentSession) — in-process when available
 *   2. spawn `pi --mode json -p --no-session` — proven fallback
 *   3. tmux — not implemented
 *
 * runViaSdk() uses createAgentSession + SessionManager.inMemory. On any
 * failure (missing export, model resolution, prompt error) it returns null
 * and the caller falls through to spawnPiJson().
 *
 * Modes: single { agent, task } only for Phase 2 exit. Parallel/chain later.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, AgentMessage } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "./dispatcher-agents.ts";

const PER_TASK_OUTPUT_CAP = 50 * 1024;

function getFinalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  // Prefer local pi.cmd when present (glitch-pi data/node layout)
  const localPi = path.join(process.cwd(), "data", "node", "pi.cmd");
  if (fs.existsSync(localPi)) {
    return { command: localPi, args };
  }
  return { command: "pi", args };
}

interface SpawnResult {
  exitCode: number;
  messages: AgentMessage[];
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
}

async function spawnPiJson(
  agent: AgentConfig,
  task: string,
  cwd: string,
  parentModel: string | undefined,
  parentThinking: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SpawnResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  // Skip OpenCode-specific models (opencode/*, opencode-go/*) — not available on Pi.
  const agentModel = agent.model && !/^opencode(-go)?\//.test(agent.model) ? agent.model : undefined;
  const inherits = !agentModel;
  const model = agentModel ?? parentModel;
  if (model) args.push("--model", model);
  if (inherits && parentThinking) args.push("--thinking", parentThinking);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptPath: string | null = null;
  const result: SpawnResult = { exitCode: 0, messages: [], stderr: "" };

  try {
    if (agent.systemPrompt.trim()) {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-dispatch-"));
      const safeName = agent.name.replace(/[^\w.-]+/g, "_");
      tmpPromptPath = path.join(tmpDir, `prompt-${safeName}.md`);
      await fs.promises.writeFile(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);

    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Marker so routing.ts gates skip dispatcher-spawned sub-agents
        // (OpenCode sub-agents ran plugin-free; this restores that behavior).
        env: { ...process.env, GLITCH_SUBAGENT: "1" },
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message as AgentMessage;
          result.messages.push(msg);
          if (msg.role === "assistant") {
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
          }
        }
        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message as AgentMessage);
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => resolve(1));

      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    return result;
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
        fs.rmdirSync(path.dirname(tmpPromptPath));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * SDK path (Plan 2 §5.2 #1): createAgentSession + SessionManager.inMemory.
 * Returns null on any failure so the caller falls through to spawnPiJson.
 */
async function runViaSdk(
  agent: AgentConfig,
  task: string,
  cwd: string,
  parentModel: string | undefined,
  parentThinking: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SpawnResult | null> {
  try {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const createAgentSession = sdk?.createAgentSession;
    const SessionManager = sdk?.SessionManager;
    if (typeof createAgentSession !== "function" || !SessionManager?.inMemory) return null;

    // Same OpenCode-model filter as spawn (opencode/*, opencode-go/* → inherit)
    const agentModel =
      agent.model && !/^opencode(-go)?\//.test(agent.model) ? agent.model : undefined;
    const modelId = agentModel ?? parentModel;

    let model: unknown;
    if (modelId) {
      const slash = modelId.indexOf("/");
      if (slash > 0) {
        try {
          const compat: any = await import("@earendil-works/pi-ai/compat");
          model = compat?.getModel?.(modelId.slice(0, slash), modelId.slice(slash + 1));
        } catch {
          model = undefined;
        }
      }
    }
    // Unresolvable explicit model → let spawn handle it (keeps known-good path)
    if (agentModel && !model) return null;

    const systemPrompt = agent.systemPrompt.trim();
    const prompt = systemPrompt ? `${systemPrompt}\n\nTask: ${task}` : `Task: ${task}`;

    const opts: Record<string, unknown> = {
      sessionManager: SessionManager.inMemory(cwd),
      cwd,
    };
    if (model) opts.model = model;
    if (agent.tools && agent.tools.length > 0) opts.tools = agent.tools;
    if (!agentModel && parentThinking) {
      try {
        opts.thinkingLevel = parentThinking;
      } catch {
        /* optional */
      }
    }

    const { session } = await createAgentSession(opts);
    const result: SpawnResult = { exitCode: 0, messages: [], stderr: "" };
    let onAbort: (() => void) | undefined;

    try {
      onAbort = () => {
        try {
          (session as any).abort?.();
        } catch {
          /* ignore */
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      await session.prompt(prompt);

      const msgs: AgentMessage[] = (session as any).state?.messages ?? [];
      for (const msg of msgs) {
        result.messages.push(msg);
        if (msg.role === "assistant") {
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
        }
      }

      if (signal?.aborted) {
        result.exitCode = 1;
        result.stopReason = result.stopReason ?? "aborted";
      }
      if (!getFinalOutput(result.messages) && result.exitCode === 0 && !result.errorMessage) {
        // Empty success → prefer spawn retry rather than returning blank
        return null;
      }
      return result;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      try {
        (session as any).dispose?.();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null; // fall through to spawn
  }
}

const TaskParams = Type.Object({
  agent: Type.String({ description: "Agent name: coder, reviewer, testing, ui-designer, vision, vision-alt, memory, memory-paid, pentester, glitch-omni" }),
  task: Type.String({ description: "Complete task description for the sub-agent. Include file paths, constraints, and expected output format."}),
  agentScope: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
      description: "Which agent directories to use. Default: both (project .pi/agents + user).",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Dispatch a task to a specialized sub-agent with an isolated context window. " +
      "Agents: coder, reviewer, testing, ui-designer, vision, vision-alt, memory, memory-paid, pentester, glitch-omni. " +
      "Use for code review, implementation, tests, design, vision analysis, memory writes, and security assessment. " +
      "Returns the sub-agent's final output.",
    parameters: TaskParams,

    async execute(_toolCallId, params, signal) {
      const cwd = process.cwd();
      const agentScope: AgentScope = (params.agentScope as AgentScope) || "both";
      const discovery = discoverAgents(cwd, agentScope);
      const agent = discovery.agents.find((a) => a.name === params.agent);

      if (!agent) {
        const available = discovery.agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent: "${params.agent}". Available: ${available}`,
            },
          ],
          details: undefined,
          isError: true,
        } as any;
      }

      const parentModel = (pi as any).__dispatchModel as string | undefined;
      const parentThinking = (pi as any).__dispatchThinking as string | undefined;

      // Try SDK first (Plan 2 §5.2), fall back to spawn
      let result = await runViaSdk(agent, params.task, cwd, parentModel, parentThinking, signal);
      if (!result) {
        result = await spawnPiJson(agent, params.task, cwd, parentModel, parentThinking, signal);
      }

      const failed =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";

      const output = failed
        ? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
        : getFinalOutput(result.messages) || "(no output)";

      return {
        content: [
          {
            type: "text",
            text: truncateOutput(
              failed
                ? `Agent ${agent.name} failed (exit ${result.exitCode}${result.stopReason ? `, ${result.stopReason}` : ""}):\n${output}`
                : output,
            ),
          },
        ],
        details: {
          agent: agent.name,
          agentSource: agent.source,
          exitCode: result.exitCode,
          stopReason: result.stopReason,
        },
        isError: failed,
      } as any;
    },
  });

  // Stash parent model/thinking for spawn inheritance (set on before_agent_start if available)
  pi.on("before_agent_start", async (event: any) => {
    try {
      const model = event?.model || event?.systemPromptOptions?.model;
      if (model) {
        (pi as any).__dispatchModel =
          typeof model === "string" ? model : `${model.provider}/${model.id}`;
      }
      if (event?.thinkingLevel) {
        (pi as any).__dispatchThinking = event.thinkingLevel;
      }
    } catch {
      /* ignore */
    }
  });
}
