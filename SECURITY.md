# Security Policy

## Reporting a vulnerability

If you find a security issue in localagent, please email
[lavuchandu169@gmail.com](mailto:lavuchandu169@gmail.com) directly rather
than opening a public issue. Include:

- A description of the vulnerability and its impact
- Steps to reproduce it
- The version/commit you tested against

You should get a response within a few days. Please give us reasonable
time to address the issue before any public disclosure.

## Supported versions

localagent is currently in beta (`0.x`). Security fixes land on the
latest release; older betas are not separately patched.

## Scope notes

localagent is local-first by design: the embedded and custom Hugging
Face models run entirely in-process, with no backend server and no
telemetry. The main areas that matter most for security review are:

- The permission engine (`src/permissions.ts`) — the risk classifier
  that decides what runs without asking
- The checkpoint/revert system (`src/checkpoints.ts`) — must never touch
  a user's real git index, HEAD, or branch
- Credential handling for Google sign-in and provider API keys (stored
  via the OS's native credential store, never as plain text)
