# Code Git UI and Review Redesign Implementation Plan

> Execute in small test-first slices; keep generated `dist/renderer/react/index.html` out of commits.

1. Add prompt-parity and Code sticker-policy regression tests; minimally wire the Code composer/run path.
2. Extract the Work Todo floating-card drag/collapse behavior and reuse it in the Code Git/Todo card.
3. Extend Git status with truthful line totals and rebuild the Code card header; remove its Review entry.
4. Add a persisted message-level Git review summary and attach it only for successful Code project mutations with remaining changes.
5. Replace the dark Ant Drawer with a white/pink docked Review panel that pushes the chat workspace and keeps `react-diff-view` for patches.
6. Run focused tests, full Vitest, main/preload/renderer builds, and inspect the final diff for unrelated or generated files.
