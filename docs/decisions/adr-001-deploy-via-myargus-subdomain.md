---
title: ADR-001 — Deploy via myargus subdomain
status: accepted
date: 2026-06-21
summary: "ADR-001: deploy atto1 as a myargus.cc subdomain on Cloudflare"
read_when:
  - wiring up deployment or hosting
  - choosing a domain or URL for the app
---

# ADR-001: Deploy via myargus subdomain

## Context

The myargus platform (myargus.cc) uses Cloudflare Pages with subdomain routing to host all
Argus-ecosystem apps under a single domain. New apps are expected to join this platform rather
than being deployed independently. atto1 is an EV tracking app that fits within this ecosystem.
The subdomain pattern keeps auth, DNS, and infrastructure consolidated.

## Decision

atto1 will be deployed as a subdomain of myargus.cc (e.g. `atto1.myargus.cc` or a descriptive
alias). Hosting will follow the established Cloudflare Pages pattern used by other myargus
projects, with a Vite build output pointed at a Pages project and a CNAME wired in Cloudflare
DNS.

## Consequences

> Amended by [ADR-004](adr-004-deploy-only-from-the-deploy-branch.md): the deploy runs only
> from the `deploy` branch, not on `main`. Amended by
> [ADR-005](adr-005-d1-worker-behind-access.md): the host is a Cloudflare Worker with static
> assets (not a Pages project), the sign-in is Cloudflare Access, and there are no Supabase
> redirect URLs. The subdomain choice below still stands.

- A Cloudflare Pages project must be created for atto1 and linked to this repo.
- A DNS CNAME record must be added under myargus.cc pointing to the Pages deployment.
- The Cloudflare API token used by the myargus platform needs Zone:DNS:Edit scope if the CNAME
  is to be managed programmatically (consistent with the known limitation documented elsewhere).
- The subdomain name should be decided before the DNS record is created, as renaming later
  requires updating any bookmarks and Supabase redirect URLs.
- Supabase auth redirect URLs will need to include the final subdomain once auth is wired up.
