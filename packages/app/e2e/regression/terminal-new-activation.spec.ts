import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TerminalNewActivation"
const projectID = "proj_terminal_new_activation"
const sessionID = "ses_terminal_new_activation"
const title = "Terminal new activation"
const ptyIDs = ["pty_new_activation_1", "pty_new_activation_2", "pty_new_activation_3"]

test.use({ viewport: { width: 1440, height: 900 } })

// The terminal tab strip is a controlled Kobalte Tabs root: it coerces its selection back to the
// first registered trigger whenever the controlled value names a key its collection has not seen
// yet. Registering a new terminal in the same update that activates it loses that race, so each
// created terminal must stay selected across repeated creations.
test("keeps each newly created terminal selected and focused", async ({ page }) => {
  await setup(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const terminal = page.locator('[data-component="terminal"]')
  await page.keyboard.press("Control+Backquote")
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expectSelected(page, "Terminal 1")

  for (const [index, name] of ["Terminal 2", "Terminal 3"].entries()) {
    await page.getByRole("button", { name: "New terminal" }).click()
    await expectSelected(page, name)
    await expect(page.getByRole("tab")).toHaveCount(index + 2)
    // Only the active terminal renders a wrapper, so this proves the store kept the new terminal
    // active instead of having the tab strip coerce it back to the first one.
    await expect(page.locator(`#terminal-wrapper-${ptyIDs[index + 1]}`)).toBeAttached()
    await expect(page.getByRole("tab", { name: "Terminal 1" })).toHaveAttribute("aria-selected", "false")
    await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }
})

async function expectSelected(page: Page, name: string) {
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true")
}

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "terminal-new-activation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "terminal-new-activation",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })

  const created = { count: 0 }
  await page.route("**/pty", (route) => {
    const id = ptyIDs[created.count++]
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ptyInfo(id!)) })
  })
  for (const id of ptyIDs) {
    await page.route(`**/pty/${id}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ptyInfo(id)) }),
    )
    await page.route(`**/pty/${id}/connect-token*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ ticket: "e2e-ticket", expires_in: 60 }),
      }),
    )
    await page.routeWebSocket(new RegExp(`/pty/${id}/connect`), () => undefined)
  }

  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory },
  )
}

function ptyInfo(id: string) {
  const number = ptyIDs.indexOf(id) + 1
  return {
    id,
    title: `Terminal ${number}`,
    command: "cmd.exe",
    args: [],
    cwd: directory,
    status: "running",
    pid: number,
  }
}
