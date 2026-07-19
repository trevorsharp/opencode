import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { createEditProjectModel } from "./edit-project"

export function DialogEditProject(props: { project: LocalProject; server: ServerConnection.Any }) {
  const language = useLanguage()
  const model = createEditProjectModel({ project: props.project, server: props.server, nameOnly: true })

  return (
    <Dialog title={language.t("dialog.project.edit.title")} class="w-full max-w-[480px] mx-auto" fit>
      <form onSubmit={model.submit} class="flex flex-col gap-6 p-6 pt-0">
        <div class="flex flex-col gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("dialog.project.edit.name")}
            placeholder={model.folderName()}
            value={model.store.name}
            onChange={(v) => model.setStore("name", v)}
          />
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={model.close}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={model.save.isPending}>
            {model.save.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
