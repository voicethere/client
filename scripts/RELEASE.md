# Release guide — `@voicethere/client`

Tag-driven npm publish via [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (`publish` job on `release/*` tag push).

## One-time setup

1. npm org **`@voicethere`** member with **read-write** publish rights (same as `@voicethere/agent` / `@voicethere/cli`).
2. GitHub repo secret **`NPM_TOKEN`** on `voicethere/client` — automation token scoped to `@voicethere` with **Publish** permission.
3. CI must pass `NODE_AUTH_TOKEN` into `actions/setup-node` (see workflow) so scoped publishes authenticate correctly.

If publish fails with `404 Not Found - PUT @voicethere/client`:

- Run `npm whoami` in the publish job log — token may be missing or read-only.
- Confirm the token owner is in the `@voicethere` npm org with publish access.
- First publish can be done locally after `npm login` (org member): `npm publish --access public` from repo root on `main` after `npm run test:ci`.

## Release

```bash
git checkout main && git pull
# Bump CHANGELOG + package.json version if needed
git tag release/0.3.0
git push origin refs/tags/release/0.3.0
```

## Verify

```bash
npm view @voicethere/client version
npm view @voicethere/client exports
```
