# TRS Theme

## Purpose

Provide the preferred TRS visual identity as a bundled light and dark theme and use it as the initial theme for users without a saved preference.

## Required Behavior

- TRS is available in the theme selector with the stable identifier `trs` and display name `TRS`.
- TRS provides coordinated light and dark variants.
- TRS is selected when no theme preference has been saved.
- Existing saved theme preferences remain unchanged.
- The active color scheme selects the corresponding TRS light or dark variant.
- Initial page rendering and hydrated application state use the same default to avoid flashing another theme.
- Avatars are rendered in grayscale while TRS is active.
- Inline code and file references use the TRS blue accent `#90caff`.
- Code blocks use the VS Code Dark+ syntax color scheme in both TRS variants.

## Light Palette

The light variant uses a warm near-white neutral foundation with dark text and a yellow-green primary accent.

| Role                  | Color     |
| --------------------- | --------- |
| Neutral foundation    | `#f7f7f7` |
| Base surface          | `#F8F8F8` |
| Raised surface        | `#F3F3F3` |
| Raised surface hover  | `#EDEDED` |
| Strong text           | `#171717` |
| Base text             | `#6F6F6F` |
| Weak text             | `#8F8F8F` |
| Weaker text           | `#C7C7C7` |
| Primary accent        | `#dcde8d` |
| Interactive blue      | `#034cff` |
| Interactive text blue | `#55aeff` |
| Weak border           | `#DBDBDB` |
| Weaker border         | `#E8E8E8` |
| Success               | `#12c905` |
| Success surface       | `#E6FFE5` |
| Warning               | `#ffdc17` |
| Error                 | `#fc533a` |
| Error surface         | `#FFF2F0` |
| Information           | `#a753ae` |
| Diff addition         | `#9ff29a` |
| Diff deletion         | `#fc533a` |

## Dark Palette

The dark variant uses a neutral charcoal foundation with off-white text and a warm peach primary accent.

| Role                  | Color     |
| --------------------- | --------- |
| Neutral foundation    | `#1f1f1f` |
| Base surface          | `#1C1C1C` |
| Raised surface        | `#232323` |
| Raised surface hover  | `#282828` |
| Strong text           | `#EDEDED` |
| Base text             | `#A0A0A0` |
| Weak text             | `#707070` |
| Weaker text           | `#505050` |
| Primary accent        | `#fab283` |
| Interactive blue      | `#034cff` |
| Interactive text blue | `#55aeff` |
| Weak border           | `#282828` |
| Weaker border         | `#232323` |
| Success               | `#12c905` |
| Success surface       | `#022B00` |
| Warning               | `#fcd53a` |
| Error                 | `#fc533a` |
| Error surface         | `#1F0603` |
| Information           | `#edb2f1` |
| Diff addition         | `#c8ffc4` |
| Diff deletion         | `#fc533a` |

## Code Colors

Code blocks use a shared VS Code Dark+ semantic palette in both the light and dark TRS variants. This keeps code visually familiar and consistent across color-scheme changes.

| Syntax role                        | Color     |
| ---------------------------------- | --------- |
| Comments                           | `#6a9955` |
| Regular expressions                | `#d16969` |
| Strings                            | `#ce9178` |
| Keywords and information           | `#569cd6` |
| Primitives and numbers             | `#b5cea8` |
| Operators and punctuation          | `#d4d4d4` |
| Variables, properties, and objects | `#9cdcfe` |
| Types and success                  | `#4ec9b0` |
| Constants                          | `#4fc1ff` |
| Warnings and function-like symbols | `#dcdcaa` |
| Critical and deletion markers      | `#f44747` |
| Unknown diff markers               | `#ff0000` |

Inline code, file chips, and highlighted file references use `#90caff` rather than the full block syntax palette.

## Shared Design

- Define TRS through the shared theme format rather than app-specific global color replacements.
- Register and export it through the standard theme registry.
- Use the same `trs` identifier in preload logic and the runtime theme provider.
- Keep the VS Code syntax palette in semantic syntax tokens so all code renderers consume the same colors.
- Scope avatar, inline-code, file-chip, and file-reference overrides to `html[data-theme="trs"]` so other themes are unaffected.

## Validation

- TRS appears in theme selection.
- A profile without a saved preference starts with TRS.
- A saved non-TRS preference is preserved.
- Light and dark variants follow the active color scheme.
- Preload and runtime rendering select the same variant.
- Code blocks use the documented VS Code colors in both variants.
- Avatars are grayscale only under TRS.
- Inline code and file references use `#90caff` only under TRS.
- TRS-specific styles do not leak into other themes.

## Non-Goals

- Replacing or removing other bundled themes.
- Overriding an existing saved theme preference.
- Applying grayscale avatars or TRS code colors to other themes.
- Using a different syntax palette for the light variant.
