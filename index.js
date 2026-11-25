import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { pathToFileURL } from "node:url";

const execAsync = promisify(exec);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL || "qwen3.5:4b";

// Hard guardrail against destructive or privileged commands
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force)\b/i,
  /\bsudo\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\b(mkfs|dd|shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/
];

export function isCommandBlocked(cmd) {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(cmd));
}

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["run", "done"] },
    command: { type: "string" },
    summary: { type: "string" }
  },
  required: ["action"],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are a local shell executor. You receive a goal and solve it by running terminal commands.
Respond ALWAYS and ONLY with valid JSON choosing one of these two actions:
1) To run one or more commands: {"action": "run", "command": "shell command"}
2) When you have gathered the requested data: {"action": "done", "summary": "concrete extracted data"}

CORE RULES:
- Combine multiple read commands into a single step using && or ; (e.g., "ls -la && git status -sb") to finish in as few steps as possible.
- Commands already execute inside the target working directory: ALWAYS use relative paths (e.g., ./file.txt) and NEVER absolute paths.
- When searching or listing files (e.g., with find or grep), always exclude .git and node_modules unless explicitly requested.
- Never run destructive commands (rm -rf, git reset --hard, sudo, etc.) or interactive/watch commands.
- The caller CANNOT see the terminal: it ONLY sees the "summary" field.
- In "summary", NEVER describe what you did (do NOT write "I ran ls" or "Checked git status"). ALWAYS report the actual extracted data directly: exact file names, sizes, values, dates, git status, relevant lines, or requested output.`;

async function askOllama(messages, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(45000);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: MODEL,
      messages,
      format: DECISION_SCHEMA,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: {
        temperature: 0,
        num_ctx: 4096,
        num_predict: 600
      }
    })
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data?.message?.content) {
    throw new Error("Empty response from Ollama");
  }
  return JSON.parse(data.message.content);
}

const server = new McpServer({ name: "local-exec", version: "1.0.0" });

server.tool(
  "local_exec",
  `Delegates a terminal task to a local Ollama model (${MODEL}) and returns the extracted result to save context tokens.`,
  {
    task: z.string().describe("Clear, self-contained objective to complete in the terminal"),
    cwd: z.string().describe("Absolute path of the working directory")
  },
  {
    title: "Local Terminal Executor",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  },
  async ({ task, cwd }, extra) => {
    const signal = extra?.signal;
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `You are already in the target working directory. Use relative paths only.\nObjective: ${task}\nRemember: in the final summary, report all concrete data obtained from the output, not a narration of what you ran.`
      }
    ];

    let consecutiveErrors = 0;
    const executedOutputs = [];
    const execEnv = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`
    };

    for (let step = 0; step < 4; step++) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation cancelled (timeout/abort)." }] };
      }

      let decision;
      try {
        decision = await askOllama(messages, signal);
      } catch (e) {
        return { content: [{ type: "text", text: `Error calling/parsing ${MODEL}: ${e.message}` }] };
      }

      if (decision.action === "done") {
        const text = (decision.summary || "").trim();
        if (text) {
          return { content: [{ type: "text", text }] };
        }
        if (executedOutputs.length > 0) {
          return { content: [{ type: "text", text: executedOutputs.join("\n\n") }] };
        }
        return { content: [{ type: "text", text: "Task completed (no output)." }] };
      }

      if (decision.action === "run" && decision.command) {
        if (isCommandBlocked(decision.command)) {
          return {
            content: [{
              type: "text",
              text: `BLOCKED: Refused to execute potentially destructive command: ${decision.command}`
            }]
          };
        }

        try {
          const { stdout, stderr } = await execAsync(decision.command, {
            cwd,
            timeout: 15000,
            maxBuffer: 5 * 1024 * 1024,
            env: execEnv,
            signal
          });
          consecutiveErrors = 0;
          const output = (stdout || stderr || "OK (no output)").trim().slice(0, 2500);
          executedOutputs.push(`$ ${decision.command}\n${output}`);
          messages.push({ role: "assistant", content: JSON.stringify(decision) });
          messages.push({
            role: "user",
            content: `Command output:\n${output}\n\nIf you have all the data needed for the objective, respond now with {"action": "done", "summary": "..."} including the actual extracted data.`
          });
        } catch (err) {
          consecutiveErrors++;
          const errText = (err.stderr || err.message || "Unknown error").trim().slice(0, 1500);
          if (consecutiveErrors >= 2) {
            return {
              content: [{
                type: "text",
                text: `FAILED after 2 consecutive errors.\nLast command: ${decision.command}\nError: ${errText}`
              }]
            };
          }
          messages.push({ role: "assistant", content: JSON.stringify(decision) });
          messages.push({ role: "user", content: `Command error:\n${errText}\nFix the command and try again.` });
        }
      } else {
        messages.push({ role: "assistant", content: JSON.stringify(decision) });
        messages.push({
          role: "user",
          content: `Invalid format: if action is "run" you must provide "command"; if finished use action "done" with "summary".`
        });
      }
    }

    if (executedOutputs.length > 0) {
      return {
        content: [{
          type: "text",
          text: `Collected output (reached 4-step limit):\n${executedOutputs.join("\n\n")}`
        }]
      };
    }

    return { content: [{ type: "text", text: "Reached maximum limit of 4 steps without completing the task." }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

export { server };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}