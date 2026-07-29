import { describe, expect, test } from "bun:test"
import {
  layoutPreferenceWritable,
  resolveLayoutAnnouncementPolicy,
  resolveLayoutPolicy,
  resolveLayoutTransitionPolicy,
} from "./legacy-layout"

describe("legacy layout policy", () => {
  test("resolves the legacy layout regardless of the upstream decision", () => {
    expect(resolveLayoutPolicy(true)).toBe(false)
    expect(resolveLayoutPolicy(false)).toBe(false)
  })

  test("hides the layout switch and transition notice", () => {
    expect(resolveLayoutTransitionPolicy({ available: true, notice: true })).toEqual({
      available: false,
      notice: false,
    })
  })

  test("hides layout announcements", () => {
    expect(resolveLayoutAnnouncementPolicy(true)).toBe(false)
    expect(resolveLayoutAnnouncementPolicy(false)).toBe(false)
  })

  test("ignores writes to the layout preference", () => {
    expect(layoutPreferenceWritable()).toBe(false)
  })
})
