import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { type LocalProject } from "@/context/layout"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"

export function DialogEditProject(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const serverCtx = createMemo(() => global.ensureServerCtx(props.server))
  const serverSDK = () => serverCtx().sdk
  const serverSync = () => serverCtx().sync

  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  const isWorkspaceRoot = createMemo(() => {
    if (props.project.id?.startsWith("feature:")) return true
    const root = `${props.project.worktree.replace(/\/+$/, "")}/`
    return props.project.sandboxes?.some((directory) => directory.startsWith(root)) ?? false
  })

  const [store, setStore] = createStore({
    name: defaultName(),
  })

  const saveMutation = useMutation(() => ({
    mutationFn: async () => {
      const name = store.name.trim() === folderName() ? "" : store.name.trim()
      const displayName = store.name.trim()
      const nextName = isWorkspaceRoot() ? displayName : name

      if (props.project.id && props.project.id !== "global") {
        await serverSDK().client.project.update({
          projectID: props.project.id,
          directory: props.project.worktree,
          name: nextName,
        })
        dialog.close()
        return
      }

      serverSync().project.meta(props.project.worktree, {
        name: nextName,
      })
      dialog.close()
    },
  }))

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (saveMutation.isPending) return
    saveMutation.mutate()
  }

  return (
    <Dialog title={language.t("dialog.project.edit.title")} class="w-full max-w-[480px] mx-auto" fit>
      <form onSubmit={handleSubmit} class="flex flex-col gap-6 p-6 pt-0">
        <div class="flex flex-col gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("dialog.project.edit.name")}
            placeholder={folderName()}
            value={store.name}
            onChange={(v) => setStore("name", v)}
          />
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
