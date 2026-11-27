# Publish an installable GitHub release

Releases contain one portable npm archive for Node.js 26 on macOS and Linux.
They are published by the [release workflow](../.github/workflows/release.yml)
when a version tag is pushed. No npm registry token is needed.

## Prepare a version

1. Update `package.json` and `npm-shrinkwrap.json` to the same version. The CLI reads
   its version from package metadata.
2. Update `CHANGELOG.md`, installation examples, and `docs/releases/vVERSION.md`.
3. Run `npm ci`, `npm run check`, `npm run test:e2e`, and `npm run verify:package`.
4. Commit and push the reviewed changes to `main`, then tag that exact commit:

```sh
git tag -a v0.1.0 -m 'Provenarium Validation v0.1.0'
git push origin v0.1.0
```

Use a new version for each release; do not replace published tags or assets.

## What CI publishes

The workflow validates the tag against package metadata, builds one `.tgz`, and
records its SHA-256 digest and source revision. The canonical `npm-shrinkwrap.json`
is included in the package so installations use the tested dependency versions.
Both macOS and Ubuntu then download
that same archive, verify its checksum, run the full test suite, and install it
outside the checkout. Package verification exercises the approved good/defective
workflow and the actual globally installed executable in an isolated npm prefix.

Only after both jobs pass does the publish job upload the archive, `SHA256SUMS`,
`release.json`, and installation/release notes to a draft release and publish it.
The initial release is marked as a prerelease while live-provider evaluation
remains pending. CI does not call provider APIs or publish to the npm registry.

For local inspection of a committed release candidate:

```sh
npm run build
node scripts/prepare-release.mjs --tag v0.1.0 --output release-assets
node scripts/verify-package.mjs release-assets/provenarium-validation-0.1.0.tgz
```

The generated `release-assets/` directory is ignored by Git. If verification fails,
inspect the failing job and correct the release candidate before publishing. A
failure during asset upload may leave a draft; inspect it before retrying. Never
silently overwrite an already published release.
