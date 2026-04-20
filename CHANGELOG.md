# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules that determine how
a given change maps to a semver bump.

## [Unreleased]

### Added

- Standalone mode support: set `VALKEY_CLUSTER_MODE=false` to connect via `GlideClient` instead of `GlideClusterClient`.
- gzip compression for cache payloads ≥1KB (`gzip(msgpack(data))`). Reads fall back to raw msgpack for keys written before this change (backward compatible rollout).

### Changed

- Circuit breakers are now keyed per `serviceName` rather than per manifest prefix. Manifest entries sharing a `serviceName` share a single breaker, so a failing upstream trips all routes pointing at it simultaneously. Previously each prefix had an independent breaker, which meant the error threshold took longer to trigger when traffic was split across routes to the same service.

### Removed

- Nothing yet.

### Fixed

- Nothing yet.
