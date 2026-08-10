# Code Git UI and Review Redesign

## Goal

Make Code mode keep Cyrene's existing Work-mode personality and task notebook, while presenting Git status and review as lightweight, contextual UI rather than an IDE.

## Frozen behavior

- Code and Work use the same Soul + Harness + tool/environment prompt assembly. Code differs only in available tools and UI.
- Code disables sticker sending and sticker insertion.
- The Code floating card reuses Work Todo's drag, collapse, bounds and mascot behavior.
- Its fixed header shows: `模式：Code`, project/binding state, branch switch, line additions/deletions, and commit/push action. The scrollable lower region shows the conversation-bound Todo list.
- The floating card never opens Review.
- A review summary is attached to the assistant turn only when that Code run successfully mutated project files and the post-run repository still contains corresponding changes. Status, branch, push, and commit-only runs do not create it.
- The review summary lists changed files and truthful line totals, is collapsible, and owns the Review entry.
- Review is a closable docked panel inside the white chat workspace. Opening it narrows the conversation area. It uses the existing white/pink visual language.
- `react-diff-view` continues to render unified/split patches. Markdown rendering is used only for prose states, never to parse diffs.

## Persistence

Review summary metadata belongs to the assistant message so switching conversations does not lose it. Diff content is loaded through the existing Git read API; when the working-tree diff no longer exists, the panel reports that the change has moved or been committed.

## Reuse boundary

- Extract and share the floating-card interaction instead of duplicating Todo drag/collapse logic.
- Reuse the existing Todo state, Git service/API, message persistence, Markdown renderer and `react-diff-view`.
- Keep custom code limited to presentation, run-to-message snapshot detection and application glue.

## Acceptance

1. Work Todo behavior is unchanged; Code card can drag and collapse identically.
2. Code card has no clickable file/review list.
3. A write/edit run with remaining Git changes produces one message review summary; Git-only runs do not.
4. Conversation switching preserves Todo and review summary.
5. Review opens inline, is white/pink, closes cleanly, and unified/split both render.
6. Code composer exposes no sticker picker and rejects sticker markers.
7. Work and Code prompt assembly is regression-tested for parity.
