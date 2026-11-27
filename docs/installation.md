# Installation

Use Node.js 26 and npm on macOS or Linux. Build and install from the checkout.

```sh
npm ci
npm pack
npm install --global ./provenarium-validation-0.1.2.tgz
```

For a published build, download the named `.tgz` and `SHA256SUMS` from the
[release page](https://github.com/andrewruba/provenarium-validation/releases).
Check the release notes for its commands, verify the archive, and install it.

```sh
shasum --algorithm 256 --check SHA256SUMS
npm install --global ./provenarium-validation-0.1.2.tgz
```

On Linux, `sha256sum --check SHA256SUMS` also verifies the archive. To update,
install the desired archive using the same Node/npm environment.

Start validation with source files and a deployment URL.

```sh
provenarium validate --context ../my-app --url https://app.example.com
```

The CLI provisions Chromium before browser work if its required build is
missing. Linux hosts may need the system libraries listed by Playwright. For
repository development, `npx playwright install --with-deps chromium` installs
the browser and those libraries and may require administrator access.

The CLI asks for an API key privately when authoring needs one. Application
credentials, when required, are collected from the test plan's access inventory.
The validation project has no `node_modules` directory.

Remove a global installation with the package manager.

```sh
npm uninstall --global provenarium-validation
```

Project files, retained results, and Chromium's shared browser cache stay in
their own locations. See the [CLI reference](cli-reference.md) for usage.
