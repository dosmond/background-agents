---
date: 2026-02-22
topic: sidebar-session-folders
---

# Sidebar Session Folders

## What We're Building

Add a repo-first folder organization model to the sidebar session list. Repositories become
top-level groups (for example, `owner/repo`), and users can create custom folders inside each repo.

Within each repo, sessions can be either assigned to exactly one folder or left in an `Unfiled`
section. The first release includes folder creation, rename, and deletion, plus drag-and-drop for
moving sessions between folders and unfiled. Session ordering inside folders and unfiled remains
automatic: most recently updated first.

## Why This Approach

We considered three directions: repo grouping only, repo grouping with folders, and global
cross-repo folders. Repo grouping with per-repo folders was chosen because it matches the target UX
and keeps organization aligned with how sessions are already tied to repositories.

This approach provides meaningful organization without introducing global taxonomy complexity. It
also keeps behavior intuitive: folders are local to a repo, sessions have a single location, and
deleting a folder does not lose sessions.

## Key Decisions

- **Repo-first hierarchy:** top-level is repo, with user-created folders nested under each repo.
- **Folder scope:** folders are per-repo only, not shared across repos.
- **Session membership:** a session can be in one folder or remain unfiled.
- **Folder operations (v1):** create, rename, delete.
- **Session move interaction (v1):** move sessions by drag-and-drop.
- **Persistence:** folder structure and mappings persist at user account level (cross-device).
- **Sort behavior:** sessions remain sorted by most recently updated first.
- **Delete behavior:** deleting a folder moves its sessions to that repo's unfiled section.

## Resolved Questions

- Should folders be per-repo or cross-repo? **Per-repo.**
- Can a session belong to multiple folders? **No, single-folder membership, with unfiled allowed.**
- Which folder actions are required in v1? **Create, rename, delete, and move via drag-and-drop.**
- Should data persist across devices? **Yes, per user account.**
- How should sessions be ordered? **Recent first.**
- What happens when a folder is deleted? **Sessions move to unfiled.**

## Open Questions

- None at this stage.

## Next Steps

-> `/workflows:plan` for implementation details, data model changes, and test strategy.
