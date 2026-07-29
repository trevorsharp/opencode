import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { pruneRetiredCommands } from "@/context/command"

type Catalog = Record<string, { title: string }>

describe("pruneRetiredCommands", () => {
  test("does not notify catalog readers when nothing is retired", () => {
    createRoot((dispose) => {
      const [catalog, setCatalog] = createStore<Catalog>({ "model.cycle": { title: "Cycle model" } })
      let computed = 0
      const keys = createMemo(() => {
        computed++
        return Object.keys(catalog)
      })

      expect(keys()).toEqual(["model.cycle"])
      expect(computed).toBe(1)

      setCatalog(produce((draft) => pruneRetiredCommands(draft)))

      expect(keys()).toEqual(["model.cycle"])
      expect(computed).toBe(1)

      dispose()
    })
  })

  test("notifies catalog readers once per retired entry removal", () => {
    createRoot((dispose) => {
      const [catalog, setCatalog] = createStore<Catalog>({
        "agent.cycle": { title: "Cycle agent" },
        "model.cycle": { title: "Cycle model" },
      })
      let computed = 0
      const keys = createMemo(() => {
        computed++
        return Object.keys(catalog)
      })

      expect(keys()).toEqual(["agent.cycle", "model.cycle"])
      expect(computed).toBe(1)

      setCatalog(produce((draft) => pruneRetiredCommands(draft)))
      expect(keys()).toEqual(["model.cycle"])
      expect(computed).toBe(2)

      setCatalog(produce((draft) => pruneRetiredCommands(draft)))
      expect(keys()).toEqual(["model.cycle"])
      expect(computed).toBe(2)

      dispose()
    })
  })
})
