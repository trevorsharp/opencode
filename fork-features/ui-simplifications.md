# UI Simplifications

## Purpose

Maintain the fork's small, intentional UI simplifications together.

The control removals apply only to legacy entry points. Shared settings dialogs, help behavior, file search, and navigation implementations remain available for other surfaces. Project ordering applies to the shared server project list.

## Required Behavior

- The legacy sidebar rail does not render a Help button.
- The legacy sidebar rail does not render a Settings button.
- The legacy command registry does not expose `settings.open`, including its keyboard shortcut.
- The centered legacy titlebar does not render the file-search button.
- The legacy titlebar does not render Back or Forward buttons.
- Help surfaces outside the legacy sidebar rail remain unchanged.
- File search and history navigation commands remain unchanged.
- Shared help icons and settings dialogs remain available.
- Newer UI surfaces remain unchanged.
- Newly opened projects are appended to the bottom of the project list instead of inserted at the top.
- Opening an existing project does not reorder it.
- Manual project reordering remains unchanged.
- No persistence or database behavior changes.

## Validation

- The legacy sidebar rail has no bottom utility buttons.
- Neither the Settings modal nor its keyboard shortcut can be opened from the legacy layout.
- The legacy titlebar has no centered search, Back, or Forward controls.
- File search remains available through its existing command.
- Shared settings, help, search, and navigation implementations continue to compile.
- Open a project that is not already listed and confirm it appears after all existing projects.
- Reopen or select an existing project and confirm its position does not change.

## Non-Goals

- Deleting shared settings dialogs, help components, icons, or translations.
- Removing Help or Settings from newer UI surfaces.
- Removing file search or navigation commands.
- Changing the behavior of retained controls.
- Sorting existing projects automatically.
