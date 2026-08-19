# Open in VS Code

## Purpose

Open project and workspace directories in a configured remote VS Code environment from the web UI.

## Dependency

Workspace Management must be implemented first. This feature adds actions to the project and workspace directory surfaces provided by that feature.

## Required Behavior

- Project roots expose an Open in VS Code action.
- Workspace member directories expose an Open in VS Code action.
- The action opens the selected project or workspace directory.
- The action is available only in the web UI.
- The action is omitted when `VITE_OPEN_IN_VSCODE_URL` is unset, invalid, or uses an unsupported URL scheme.
- No default VS Code URL is provided.
- Supported URL schemes are `http:`, `https:`, and `vscode:`.

## URL Construction

The configured value is a base URL. One shared URL builder combines that base with the selected absolute directory.

### HTTP and HTTPS URLs

- Parse the configured value as a URL.
- Set the `folder` query parameter to the complete absolute directory.
- Replace an existing `folder` parameter rather than adding a duplicate.
- Preserve unrelated query parameters and URL fragments.
- Allow the URL implementation to percent-encode the query value. Directory separators are therefore encoded as part of the `folder` value.

For example:

```text
Base:      https://code.example.com/open?theme=dark
Directory: /home/sharp/my project
Result:    https://code.example.com/open?theme=dark&folder=%2Fhome%2Fsharp%2Fmy+project
```

The exact encoding of spaces may be `%20` or `+` according to the URL implementation. Decoding the `folder` parameter must produce the original absolute directory.

### VS Code URLs

- Parse the configured value as a `vscode:` URL.
- Append the absolute directory to the base URL path.
- Normalize the boundary between the base path and directory so it contains exactly one `/`.
- Preserve `/` separators within the directory while percent-encoding characters that are not safe in a URL path.
- Set the `windowId` query parameter to `_blank` so VS Code opens the directory in a new window.
- Replace an existing `windowId` parameter rather than adding a duplicate.
- Preserve unrelated query parameters and URL fragments.

For example:

```text
Base:      vscode://vscode-remote/ssh-remote+code-server
Directory: /home/sharp/my project
Result:    vscode://vscode-remote/ssh-remote+code-server/home/sharp/my%20project?windowId=_blank
```

The directory appended to a `vscode:` URL is a path, not a query parameter. Decoding the appended path must reproduce the selected absolute directory.

## Shared Design

- Use one shared URL-construction function for project and workspace actions.
- The URL builder returns no URL for missing, malformed, or unsupported configuration.
- Use one shared action for opening the selected directory.
- Project and workspace menus only supply their directory.
- In workspace menus, Open in VS Code remains grouped directly with New Session; removal actions retain their separate group.
- Keep URL-format handling independent from menu rendering.

## Validation

- The action is absent when `VITE_OPEN_IN_VSCODE_URL` is unset, malformed, or unsupported.
- Project roots open the correct directory.
- Workspace members open their own directory.
- HTTP and HTTPS URLs set exactly one `folder` query parameter.
- HTTP and HTTPS URLs preserve unrelated query parameters and fragments.
- `vscode:` URLs append the directory with exactly one boundary separator.
- `vscode:` URLs set exactly one `windowId=_blank` query parameter.
- `vscode:` URLs preserve unrelated query parameters and fragments.
- Spaces, reserved characters, and non-ASCII characters round-trip to the original directory.

## Non-Goals

- Providing a default VS Code endpoint.
- Supporting non-web clients.
- Discovering installed editors.
- Supporting multiple editor choices.
- Copying directory paths.
- Opening or creating pull requests.
