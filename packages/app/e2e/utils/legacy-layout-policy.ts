import { test } from "@playwright/test"
import { legacyLayoutOnly } from "../../src/context/legacy-layout"

/**
 * Skips an upstream spec whose assertions describe the v2 web layout.
 *
 * The `legacy-web-ui-only` fork policy forces every profile onto the legacy layout, including
 * profiles that persist `newLayoutDesigns: true`, so the v2 surfaces these specs drive never
 * render and the spec cannot be made to pass without weakening the policy. The v2 implementation
 * stays in the repository untouched, so each skip disappears on its own once `legacyLayoutOnly`
 * is turned off — the specs are not deleted, adapted, or filtered out by path.
 *
 * Only use this for assertions that are unreachable by policy. A spec that merely fails on the
 * legacy layout is a fork regression and must be fixed instead.
 *
 * Call it at file scope when every test in the file targets v2, or as the first statement of a
 * test body when only some of them do. `surface` names the v2 surface that cannot be reached.
 */
export function skipWhenV2LayoutUnreachable(surface: string) {
  test.skip(legacyLayoutOnly, `legacy-web-ui-only policy: ${surface}`)
}

/**
 * Skips an upstream spec the legacy layout does reach, but whose fixed viewport is calibrated to
 * the v2 layout's chrome.
 *
 * These specs pin a viewport size and then assert on geometry that only holds for the timeline
 * height the v2 chrome leaves behind. The legacy chrome is a different height, so the same
 * assertion measures a different slice of the same, identically behaving surface. Adjusting the
 * pinned viewport would be adapting the upstream spec, and loosening the assertion would drop real
 * coverage, so the spec waits for the policy instead.
 *
 * Use this only after confirming the underlying behavior matches the v2 layout and that the spec
 * passes on legacy once the viewport accounts for the chrome difference. `reason` states the
 * measurement that does not survive the chrome change.
 */
export function skipWhenViewportTunedToV2Chrome(reason: string) {
  test.skip(legacyLayoutOnly, `legacy-web-ui-only policy: ${reason}`)
}
