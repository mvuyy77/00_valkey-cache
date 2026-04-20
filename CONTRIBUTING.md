# Contributing

## Versioning rules

This package follows semantic versioning. Because the service manifest
(`src/config/manifest.ts`) is part of the public surface, manifest changes
carry the same semver weight as library API changes. Use the table below
when deciding the version bump for a PR.

| Change | Bump | Why |
|---|---|---|
| Add a new entry to `SERVICES_MANIFEST` | **minor** | Purely additive — no existing consumer is affected. |
| Add a new value to the `ServiceManifest` enum (with matching manifest entry) | **minor** | Additive type surface. |
| Change `relativePath`, `method`, `TTLInSeconds`, or `apiFetchTimeoutInSeconds` on an existing entry | **major** | Consumers calling that key will observe different upstream behavior or different cache lifetimes. This is a silent behavior change — force consumers to read the changelog. |
| Remove an entry from `SERVICES_MANIFEST` or a value from the enum | **major** | Calls against the removed key will throw `PREFIX_NOT_FOUND` at runtime. |
| Change a public type in `src/types/types.ts` in a non-additive way | **major** | Breaks consumer compile. |
| Add a new public type or field (optional) in `src/types/types.ts` | **minor** | Additive. |
| Library internals (`core/service.ts`, `core/client.ts`) — bug fixes, refactors, performance, no behavior change | **patch** | No consumer-visible impact. |
| Library internals with behavior change (e.g., different retry policy, different cache-key algorithm) | **major** | Consumers' observable behavior changes even though their code doesn't. |
| Docs, tests, tooling, CI only | no bump | Not a release. |

When in doubt, pick the higher bump. It is always safer to force a
conscious consumer upgrade than to silently propagate a behavior change
through auto-merged minor bumps.

## Changelog

Every PR that warrants a bump must add an entry to `CHANGELOG.md` under
the `[Unreleased]` section, in the appropriate category (`Added`,
`Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). When a release
is cut, the `[Unreleased]` section is renamed to the new version and a
fresh `[Unreleased]` section is started.

## PR checklist

The pull request template captures the minimum a reviewer should see
before merging:

1. Summary of the change.
2. Semver bump category (from the table above).
3. Changelog entry.
4. Any manifest changes called out explicitly so they get an extra set
   of eyes.

## Manifest changes specifically

When touching `src/config/manifest.ts`:

- Confirm the change is actually driven by an upstream (nginx location
  directive) change, not a guess.
- Secrets belong in `process.env`, never as literals in the manifest.
- Verify that the enum key and the manifest key match exactly. The
  `Partial<Record<ServiceManifest, ServiceManifestConfig>>` typing
  prevents drift on added entries but does not catch typos in the
  computed key itself — read the diff carefully.
