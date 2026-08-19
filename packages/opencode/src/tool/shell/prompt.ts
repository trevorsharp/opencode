import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell notes
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- Escape special characters with the PowerShell backtick character.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- Escape special characters with the PowerShell backtick character.`
  }
  return ""
}

function bashCommandSection(limits: Limits, defaultTimeoutMs: number) {
  return `# Bash shell notes
- Quote paths containing spaces.
- Chain dependent commands with \`&&\`. Use \`;\` only when later commands should run regardless of earlier failures.
- Issue independent commands as separate tool calls so they can run concurrently.
- Use the \`workdir\` parameter instead of changing directories in the command.

The \`command\` argument is required. The optional timeout is in milliseconds and defaults to ${defaultTimeoutMs}ms.
Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated and saved to a file. Inspect that file with the dedicated tools available in your context rather than truncating command output.`
}

function powershellCommandSection(name: string, pathSep: string, limits: Limits, defaultTimeoutMs: number) {
  return `${powershellNotes(name)}
- Quote paths containing spaces and use \`-LiteralPath\` where supported. Invoke native executables at paths containing spaces with \`& "path${pathSep}to${pathSep}executable"\`.
- ${name === "powershell" ? "Chain dependent commands with `cmd1; if ($?) { cmd2 }`. Use `cmd1; cmd2` when the second command should run regardless of failure." : "Chain dependent commands with `&&`. Use `;` only when later commands should run regardless of earlier failures."}
- Issue independent commands as separate tool calls so they can run concurrently.
- Use the \`workdir\` parameter instead of changing directories in the command.

The \`command\` argument is required. The optional timeout is in milliseconds and defaults to ${defaultTimeoutMs}ms.
Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated and saved to a file. Inspect that file with the dedicated tools available in your context rather than truncating command output.`
}

function cmdCommandSection(limits: Limits, defaultTimeoutMs: number) {
  return `# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Use %VAR% for environment variables.
- Use \`call\` when invoking batch files from another batch-style command.
- Chain dependent commands with \`&&\`. Use \`&\` only when later commands should run regardless of earlier failures.
- Issue independent commands as separate tool calls so they can run concurrently.
- Use the \`workdir\` parameter instead of changing directories in the command.

The \`command\` argument is required. The optional timeout is in milliseconds and defaults to ${defaultTimeoutMs}ms.
Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated and saved to a file. Inspect that file with the dedicated tools available in your context rather than paginating command output.`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  if (CMD.has(name)) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: cmdCommandSection(limits, defaultTimeoutMs),
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: powershellCommandSection(name, platform === "win32" ? "\\" : "/", limits, defaultTimeoutMs),
    }
  }
  return {
    intro:
      "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.",
    workdirSection:
      "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.",
    commandSection: bashCommandSection(limits, defaultTimeoutMs),
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const selected = profile(name, platform, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: Global.Path.tmp,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      toolName: ShellID.ToolID,
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
