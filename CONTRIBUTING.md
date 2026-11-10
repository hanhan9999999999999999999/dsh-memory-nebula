# Contributing

Thanks for looking. This is a small, dependency-free plugin, and the fastest
way to keep it healthy is to run the same checks CI runs.

## Setup

- Node.js 22.13 or newer (CI covers 22.13 and 24).
- No install step: the package has no runtime or dev dependencies.
- The repo is the plugin source. To try it inside DSH, point a profile at this
  directory or install the packed tarball; see `docs/distribution.md`.

## Before opening a pull request

```bash
npm test          # node --test "test/*.test.mjs"
npm run check     # static release checks (version, UTF-8, links, assets)
```

For HTTP or UI changes, also start the standalone engine and run the smoke
tests:

```bash
node lib/standalone.mjs --port 7891 --root <a-memory-root>
node scripts/smoke.mjs http://127.0.0.1:7891/api/memory-nebula
```

If you change the market index or locale files, keep the package version and
`market/index.json` version in sync; `test/market.test.mjs` enforces it.

## Rules of the house

- Read-only toward memory stores. Never write into `~/.dsh-meow`, OpenViking
  directories, or user notes.
- No new runtime dependencies without a strong reason; the single-file
  snapshot and offline story depend on shipping everything ourselves.
- Keep UI strings in `lib/web/i18n.js`; Chinese is the source text. If you add
  a visible string, add the English entry and run `dev/check-i18n.mjs`.
- Add a test for behavior changes. A bug fix without a regression test will
  usually be asked for one.
- Keep commits focused. Update `CHANGELOG.md` for user-visible changes and bump
  the version only when preparing a release.

## Reporting bugs

Open an issue with the version, platform, and the diagnostics report from
`?` → “复制诊断” (it contains no memory text or local paths). For security
issues use `SECURITY.md`, not a public issue.
