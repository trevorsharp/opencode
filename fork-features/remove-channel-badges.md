# Remove Channel Badges

## Purpose

Remove release-channel labels from the legacy title bar.

## Required Behavior

- No `DEV`, `BETA`, or other channel badge is rendered.
- Production, beta, development, and fork builds behave identically in this part of the title bar.
- Channel detection remains available for update and runtime behavior.
- Update controls continue using the actual release channel.
- Only visual channel labels are removed.
- Development builds retain a label-free control for showing and hiding debug tools.

## Validation

- No build channel displays a title-bar badge.
- Removing badges does not change title-bar spacing unexpectedly.
- Update behavior still reflects the actual channel.
- Release-channel detection remains unchanged.
- Development debug tools can still be toggled without rendering a channel badge.

## Non-Goals

- Changing the active release channel.
- Treating non-production builds as production.
- Changing update availability or installation.
- Removing channel information from diagnostics or logs.
