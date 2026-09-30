@AGENTS.md

## Gates

- Before you finish, run `npm run check:changed`. It is the same check the stop hook runs.
- The full gate is `env -u ELECTRON_RUN_AS_NODE npm test`; CI runs it on every pull request.
- `docs/enforcement.md` maps every AGENTS.md rule to the check that holds it.
