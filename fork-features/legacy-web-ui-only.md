# Legacy Web UI Only

## Purpose

Keep this fork exclusively on the legacy web application layout while retaining the upstream v2 UI implementation unchanged.

## Required Behavior

- The legacy layout is always active in the web UI.
- New profiles use the legacy layout.
- Existing saved v2 layout preferences are ignored.
- Upgrades never automatically enable the v2 layout.
- Release channels, layout sunset dates, and transition eligibility do not change the active layout.
- Layout transition prompts and notices are not shown.
- The layout switch is completely hidden.
- Calling the layout-setting API cannot activate the v2 layout.

## Fork Boundary

- Fork-specific UI features and refinements target only the legacy web UI.
- The v2 UI remains in the repository so upstream changes can continue to rebase normally.
- Fork features do not need equivalent v2 implementations.
- The fork should avoid modifying v2 UI files unless required to preserve build or shared-contract compatibility.
- Removing this policy in the future should expose the upstream v2 UI rather than a fork-maintained version of it.

## Shared Design

- Resolve the active layout through one shared capability or settings boundary.
- Every layout consumer reads that resolved value rather than implementing its own fork check.
- Keep the override separate from upstream transition machinery where possible so it remains easy to reapply or remove during rebasing.
- Keep the v2 implementation present but prevent all normal activation paths.

## Upstream Test Suite

- Upstream end-to-end specs that drive v2 surfaces cannot pass while the policy is active, because
  no profile reaches the v2 layout.
- Such specs are kept, not deleted, adapted, or excluded by path, and are marked one at a time with
  `skipWhenV2LayoutUnreachable` (`packages/app/e2e/utils/legacy-layout-policy.ts`), naming the v2
  surface that is out of reach. The marker reads the same `legacyLayoutOnly` flag the runtime uses,
  so dropping the policy restores the coverage automatically.
- Mark a whole spec file only when every test in it targets v2; otherwise mark the individual tests.
- A spec that reaches its surfaces on the legacy layout but pins a viewport calibrated to the v2
  chrome is marked with `skipWhenViewportTunedToV2Chrome` instead, and only after confirming the
  behavior matches v2 and that the spec passes on legacy once the viewport accounts for the chrome
  height difference. Repinning the viewport would adapt the upstream spec and loosening the
  assertion would drop coverage, so neither is done.
- A spec that fails on the legacy layout for any other reason is a fork defect and is fixed rather
  than marked. Each marker states the specific v2 surface or measurement involved, not the feature
  the spec appears to cover, so a shared surface is never mislabeled as unreachable.

## Validation

- Fresh profiles render the legacy layout.
- Profiles containing `newLayoutDesigns: true` still render the legacy layout.
- Development and production channels behave identically.
- Version upgrades do not change the layout.
- Transition dates and eligibility flags have no effect.
- The layout switch and transition notices are absent.
- No settings API or normal navigation path activates the v2 layout.
- The retained v2 implementation continues to compile without fork-specific feature work.
- The end-to-end suite reports every v2 spec as an explained skip and no unexplained failure.

## Non-Goals

- Deleting or maintaining a fork-specific version of the v2 UI.
- Porting legacy fork features to v2.
- Maintaining fork-specific copies of upstream layout-transition policy.
- Preventing upstream v2 code from continuing to evolve.
