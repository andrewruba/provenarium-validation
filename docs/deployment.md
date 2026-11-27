# GitHub Pages deployment

Both browser-only Dilution Bench demos are published from this repository:

- [Corrected app](https://andrewruba.github.io/provenarium-validation/correct/)
- [Deliberately faulty app](https://andrewruba.github.io/provenarium-validation/faulty/)
- [Demo index](https://andrewruba.github.io/provenarium-validation/)

The public site serves HTML, CSS, and JavaScript. Calculations and preparation
records stay in the browser; there is no application server, database, or hosting
account to configure. The original Node demonstration remains available locally
for testing backend HTTP behavior.

## Deployment flow

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to
`main`. It checks formatting, types, unit tests, browser workflows, and clean npm
package installation on macOS and Ubuntu. The browser checks exercise the static
apps under a repository-style URL prefix as well as the existing Node examples.

After both operating-system jobs pass on `main`, the workflow builds `_site/`,
uploads only that generated directory, and deploys it using GitHub Pages. Pull
requests run verification without publishing. The `github-pages` environment
records the deployment and its actual URL. No custom deployment token is needed;
the deploy job uses GitHub's scoped Pages and OIDC permissions.

```text
Push to main
  → macOS and Ubuntu verification
  → build static demo assets
  → publish GitHub Pages
```

For a new fork, enable **Settings → Pages → Source: GitHub Actions**, then run
**Actions → CLI verification → Run workflow** on `main`. Public repositories can
use free Pages hosting. The site uses relative links, so it also works under a
different repository name. Update the example URLs in documentation and the
manual validation workflow for your fork.

GitHub documents the required permissions and artifacts in its
[custom Pages workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Local preview

```sh
npm run demo:pages
```

Open `http://127.0.0.1:4176/`. The preview serves only the generated static files;
it does not emulate a backend. Stop with Ctrl+C. To use another port:

```sh
npm run demo:pages -- --port 4180
```

`npm run build:pages` builds without starting a server. The generated directory is
ignored by Git. Each variant includes a `version.json` identifying its mode and
build commit. That metadata helps detect a stale deployment; it is not independent
proof of source-to-deployment equivalence.

## Verify the published deployment

Use the same [validation workflow for the Pages demos](testing-hosted-dilution.md).
The **Published Pages validation** Actions workflow runs the repository
fixtures against the live URLs and retains HTML reports and browser evidence. Run it after the Pages deployment is complete;
it is separate from the pre-deployment gate so publication cannot wait on itself.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Pages deploy job fails or reports the site missing | Enable Pages with GitHub Actions as its source and check repository/environment permissions. |
| Site initially returns 404 | Wait for the deployment to complete and use its reported URL, including the repository path. |
| Changes seem stale | Inspect the variant's `version.json`, reload the page, and compare its commit with the deployment. |
| Verification targets the wrong build | Wait for the selected workflow revision to deploy. |
| Duplicate IDs or extra records during manual use | Click Clear preparations in the same version and workspace before repeating a test. |
| Saving fails | Allow browser local storage; the app reports unavailable/full storage without claiming the record was saved. |
| HTTP checks return 404 | Use the browser-only Pages protocol. The original Node protocol expects a backend and is a different fixture. |

The earlier Render setup has been superseded by GitHub Pages. No Render account,
service, deploy hook, or API key is needed for these published demos.
