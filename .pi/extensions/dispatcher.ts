/**
 * dispatcher.ts — Pi extension: Glitch sub-agent dispatcher (Plan 2 §5.2)
 *
 * Registers a `task` tool (OpenCode-compatible name) so routing.ts can track
 * dispatches and the review gate works. Agents are discovered from:
 *   - project: .pi/agents/*.md   (Glitch's 10 defs)
 *   - user:    ~/.pi/agent/agents/*.md
 *
 * Spawn strategy (Plan 2 §5.2 ranking):
 *   1. Pi SDK (createAgentSession) — preferred when available in-process
 *   2. spawn `pi --mode json -p --no-session` — boring fallback (PROVEN; used now)
 *   3. tmux — not implemented
 *
 * Current implementation uses strategy 2 for reliability (matches the official
 * subagent example). SDK path is isolated in runViaSdk() for a later swap.
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
 * SDK path (preferred, Plan 2 §5.2 #1) — stub for Phase 2.1 polish.
 * When enabled, will use createAgentSession({ tools, model, cwd }) +
 * session.prompt(task) and collect assistant messages without a subprocess.
 */
async function runViaSdk(
  _agent: AgentConfig,
  _task: string,
  _cwd: string,
  _signal: AbortSignal | undefined,
): Promise<SpawnResult | null> {
  return null; // not yet — fall through to spawn
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

      // Try SDK first (Plan preference), fall back to spawn
      let result = await runViaSdk(agent, params.task, cwd, signal);
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
