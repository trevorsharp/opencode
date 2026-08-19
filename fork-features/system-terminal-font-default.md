# System Terminal Font Default

## Purpose

Use the system monospace font for terminals instead of assuming JetBrains Mono Nerd Font is installed.

## Required Behavior

- New profiles default the terminal font to System Mono.
- Terminal text uses the same system monospace fallback stack as other monospace UI.
- Existing explicit terminal font preferences remain unchanged.
- Users can still select another terminal font.
- Missing optional fonts do not change terminal layout unexpectedly.

## Shared Design

- Define the default and fallback stack once in shared settings.
- Terminal consumers read the resolved setting rather than defining their own fallback.
- Do not bundle or require a specific system font.

## Validation

- A new profile resolves to System Mono.
- Existing saved font preferences are preserved.
- Systems without JetBrains Mono render through the system stack.
- Changing the terminal font still works.
- Non-terminal typography remains unchanged.

## Non-Goals

- Bundling a terminal font.
- Removing font customization.
- Changing code-block or editor fonts.
- Modifying v2-specific typography.
