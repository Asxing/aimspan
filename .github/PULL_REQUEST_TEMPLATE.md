## Problem and change

Describe the problem and the resulting user-visible behavior. Link the relevant issue if there is one.

## Validation

List the checks you ran, their results and any behavior that remains unverified. Use synthetic data in screenshots and examples.

- [ ] `pnpm verify` passed.
- [ ] `pnpm verify:smoke` passed.
- [ ] `git diff --check` passed, and I inspected the complete diff.
- [ ] No real user data, transcripts, databases, credentials or unredacted screenshots are included.
- [ ] Every added or changed UI string goes through `apps/desktop/src/shared/i18n/` in both `en` and `zh-CN` (or no UI strings changed).
- [ ] The change preserves read-only native sources and never sends to an agent.
