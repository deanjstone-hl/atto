# Diagrams

Diagrams for atto1: the Worker behind Access over D1, a dashboard read, a BYD collector run, and how a change reaches production. Open the `.html` file in a browser. Each is self-contained static HTML/SVG in the house style of [argus-config/1432](https://github.com/deanjstone/argus-config/issues/1432): system fonts, no network request, theme-aware (host CSS variables, with a `prefers-color-scheme` dark fallback), and 360 px wide so a phone needs no sideways scroll. They are drawn from the repo's own code, README and docs, and checked with the diagram-design plugin's `self_check.py` (`OK`) and `verify-geometry.py` (`0 finding(s)`).

Every step node is `<g id="step-<flow>-<step>">`, the deep-link contract of [ops-hub/13](https://github.com/deanjstone/ops-hub/issues/13); the targeted step is highlighted with `:target`. The flow slug starts with the repo name, so a step id is unique across repos.

| Diagram | Type | Step ids | Sources |
|---|---|---|---|
| [`architecture.html`](architecture.html) | Architecture | `step-atto1-arch-`: `byd` `browser` `collector` `access` `worker` `assets` `d1` | `README.md`, `docs/byd-collector.md`, `worker/index.ts`, ADR-005 |
| [`dashboard-flow.html`](dashboard-flow.html) | Sequence | `step-atto1-flow-`: `open` `access` `request` `verify` `read` `render` | `worker/index.ts`, `README.md` |
| [`collector-flow.html`](collector-flow.html) | Sequence | `step-atto1-ingest-`: `timer` `read` `map` `sessions` `post` `verify` `write` `state` | `docs/byd-collector.md`, `collector/`, `worker/ingest.ts`, ADR-006 |
| [`build-deploy.html`](build-deploy.html) | Pipeline | `step-atto1-deploy-`: `push` `ci` `ff` `approve` `gates` `release-test` `render` `release` `migrate` `ship` | `README.md` (Private values, Deploy, Releases), `docs/deploy-branch.md`, `.github/workflows/` |

## Not drawn

- Private values: ids, hostnames and addresses are never drawn. Services and roles are named, not located (public-safe, [argus-config/1433](https://github.com/deanjstone/argus-config/issues/1433)).
- Marked `[speculation]`: whether the collector timer is live now (it is owner-enabled and was not checked).

## Redrawing

The diagrams are hand-checked against their sources, not generated from them. After the sources change, redraw in the same style and rerun the plugin's `self_check.py` (in the skill directory) and `verify-geometry.py` (in the plugin's `scripts/`).
