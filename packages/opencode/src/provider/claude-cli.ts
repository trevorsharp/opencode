import { existsSync } from "fs"
import os from "os"
import path from "path"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { which } from "@opencode-ai/core/util/which"
import type { Info, Model } from "./provider"

export const PROVIDER_ID = ProviderV2.ID.make("claude-cli")

/**
 * Execution-type marker used in place of an AI SDK package name. Models carrying
 * it are run by the external-agent runtime instead of an HTTP provider, so no
 * npm package is ever resolved for them.
 */
export const EXECUTION = "claude-cli"

export const EXECUTABLE = "claude"

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * How long the CLI may stay silent before the turn is settled as timed out. The
 * CLI streams an event for every block and tool result, so a long quiet window
 * means the process is stuck rather than working. Override per installation with
 * `provider["claude-cli"].options.chunkTimeout`.
 */
export const IDLE_TIMEOUT = 300_000

const MODELS: { id: string; name: string }[] = [
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
]

const CONTEXT_LIMIT = 200_000
const OUTPUT_LIMIT = 64_000

function model(input: { id: string; name: string }): Model {
  return {
    id: ModelV2.ID.make(input.id),
    providerID: PROVIDER_ID,
    name: input.name,
    family: "claude-cli",
    api: { id: input.id, url: "", npm: EXECUTION },
    status: "active",
    headers: {},
    options: {},
    // The CLI reports its own spend; opencode does not price these turns.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: CONTEXT_LIMIT, output: OUTPUT_LIMIT },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries(EFFORTS.map((effort) => [effort, { effort }])),
  }
}

export function catalog(): Info {
  return {
    id: PROVIDER_ID,
    name: "Claude CLI",
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries(MODELS.map((item) => [item.id, model(item)])),
  }
}

/**
 * Claude CLI models are only offered when the executable is on PATH and the CLI
 * has credentials. Credentials live in the keychain on macOS, so there the
 * executable alone is treated as enough.
 */
export function available(env: Record<string, string | undefined>): boolean {
  if (!which(EXECUTABLE, env)) return false
  if (env["ANTHROPIC_API_KEY"] || env["CLAUDE_CODE_OAUTH_TOKEN"]) return true
  if (process.platform === "darwin") return true
  const dir = env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude")
  return existsSync(path.join(dir, ".credentials.json"))
}

export * as ClaudeCLI from "./claude-cli"
