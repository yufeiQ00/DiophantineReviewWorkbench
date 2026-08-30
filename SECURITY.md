# Security

The workbench is a single-user local development tool. Its Sage pane executes
arbitrary Sage/Python code with the permissions of the server process and is
not a sandbox.

- Keep the server bound to `127.0.0.1`.
- Do not deploy it, expose it through a tunnel, or run it as a shared service.
- Review code before execution, including AI-generated suggestions.
- Stop the process when the review session is complete.

The target repository is read-only except for the deliberate Sage/Python
execution surface. Development context uses Git inspection commands only,
repository-file previews use an explicit allowlist, and review notes remain in
browser local storage.

Please report a suspected vulnerability privately to the repository owner
until a public security contact is documented.
