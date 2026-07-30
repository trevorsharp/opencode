// Fork policy: this fork ships only the legacy web layout. Upstream's v2 layout and its
// transition machinery stay in the repository untouched, so every activation path is routed
// through this module and the policy can be reapplied or dropped in one place.
export const legacyLayoutOnly: boolean = true

export function resolveLayoutPolicy(upstream: boolean) {
  return legacyLayoutOnly ? false : upstream
}

export function resolveLayoutTransitionPolicy(upstream: { available: boolean; notice: boolean }) {
  return legacyLayoutOnly ? { available: false, notice: false } : upstream
}

export function resolveLayoutAnnouncementPolicy(upstream: boolean) {
  return legacyLayoutOnly ? false : upstream
}

export function layoutPreferenceWritable() {
  return !legacyLayoutOnly
}
