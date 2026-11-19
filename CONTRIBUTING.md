# Contributing

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) to drive automated versioning via [semantic-release](https://semantic-release.gitbook.io/). When the owner promotes `main` to `deploy`, the `Release` workflow (`.github/workflows/release.yml`) scans the promoted commits to decide the next version and the GitHub release: one version per promotion, never one per merge. A merge to `main` cuts no version.

Format:

```
type(scope): subject

body (optional)

footer (optional)
```

| Type | Effect | Example |
|---|---|---|
| `fix` | patch release (`x.y.Z`) | `fix: correct @/* path alias for shadcn CLI compatibility` |
| `feat` | minor release (`x.Y.z`) | `feat: add charging session entry form` |
| `feat!` / `fix!` / footer `BREAKING CHANGE:` | major release (`X.y.z`) | `feat!: drop legacy task-file workflow` |
| `docs`, `chore`, `ci`, `refactor`, `test`, `style` | no release (a promotion of only these deploys and cuts no version) | `docs: add project goals from CORTEX captures` |

`scope` is optional and free-form.

Trunk-based: push small commits straight to `main` after `pnpm run check` passes (CI runs the same command on every push to `main`, and Release runs it on the promoted SHA). A squash-merged PR, where one is used, should carry a Conventional Commits–style title, since that becomes the commit message on `main`. Past commits predate this convention and are left untouched.
