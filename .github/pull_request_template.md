# Pull Request

## Summary

<!-- What does this PR change and why? 1-3 sentences. -->

## Type of change — pick exactly one

- [ ] **major** — breaking change (removed or changed manifest entry, changed public type, changed library behavior)
- [ ] **minor** — additive (new manifest entry, new enum value, new optional type field)
- [ ] **patch** — bug fix or internal refactor with no consumer-visible change
- [ ] **no bump** — docs, tests, tooling, CI only

> See [CONTRIBUTING.md](../CONTRIBUTING.md#versioning-rules) if unsure. When in doubt, pick the higher bump.

## Manifest changes

<!-- Only fill this out if src/config/manifest.ts was touched. Otherwise delete this section. -->

- [ ] I confirmed the change mirrors the upstream nginx location directive
- [ ] No secrets (API keys, tokens) are literal values — all read from `process.env`
- [ ] Enum key and manifest key match exactly

## Changelog

- [ ] I added an entry under `[Unreleased]` in `CHANGELOG.md` in the appropriate category

## Testing

<!-- How was this verified? Bench runs, local integration tests, etc. -->

## Checklist

- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Relevant benchmarks still pass
- [ ] I read my own diff before requesting review
