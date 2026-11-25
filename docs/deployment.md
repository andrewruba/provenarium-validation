# Deploy both dilution demos through CI/CD

The repository's [Render Blueprint](../render.yaml) defines two free Node web
services: `provenarium-dilution-faulty` and `provenarium-dilution-correct`. They use
the same application source with different `DILUTION_MODE` values. The validation
CLI runs on your computer or a GitHub Actions runner; the hosted services run
only the demonstration app.

## One-time setup

The Blueprint is configuration, not evidence of a live deployment. A Render
workspace must first be connected to this private GitHub repository.

1. Commit and push the setup to `main`, then confirm that both operating-system
   jobs in **CLI verification** pass for that commit.
2. In Render, connect your GitHub account and grant access to
   `andrewruba/provenarium-validation`. The repository can remain private; the
   demonstration URLs will be public.
3. Choose **New → Blueprint**, select this repository and branch `main`, and
   select `render.yaml`. Confirm that the proposed resources are exactly the two
   **Free** web services. No database, persistent disk, or paid compute is needed.
4. Create the Blueprint. Treat this first provisioning as a separate bootstrap:
   start it only after step 1 is green. Wait for both services to become live.
5. Copy each service's actual HTTPS URL from Render. Do not assume a hostname
   from its service name: Render may assign a suffix. Open `/health` on each URL
   and check `application: "Dilution Bench"` and its `mode`.
6. Follow [Testing the CLI against hosted demos](testing-hosted-dilution.md) to
   run the prepared protocol or test AI authoring. Keep the two service URLs
   labeled by mode.

Neither Render API credentials nor deploy-hook URLs belong in the repository.
This setup uses Render's GitHub integration, so it requires no deployment secret
in GitHub Actions. Creating the Blueprint is the only service-provisioning step.

## What happens after each push

```text
Push to main
  → GitHub Actions verifies the CLI on Ubuntu and macOS
  → all checks pass
  → Render builds and deploys both app modes
  → /health identifies the running mode and commit
```

The [CI workflow](../.github/workflows/ci.yml) checks the deployment configuration,
formatting, types, unit and browser tests, and clean-package installation. A new
run cancels unfinished verification for the same branch or pull request. Pull
requests run checks but do not deploy their branch. **Run workflow** can rerun
verification manually.

Each service declares `autoDeployTrigger: checksPass`, Render's **After CI Checks
Pass** setting. Render observes GitHub checks and performs the deployment; there
is no GitHub job that calls a deploy hook. Failed or cancelled checks prevent an
automatic release. Preserve this setting rather than selecting **On Commit**.
Render treats neutral and skipped checks as passing, so the qualification jobs
are deliberately unconditional for pushes to `main`.

See Render's [CI integration](https://render.com/docs/deploys#integrating-with-ci)
and [Blueprint reference](https://render.com/docs/blueprint-spec#autodeploytrigger).

## Runtime settings and test data

The Blueprint pins Node.js to the same version as `.nvmrc`, installs from
`package-lock.json`, builds the application, and starts the compiled server.
`HOST=0.0.0.0` exposes the HTTP listener to Render's proxy; Render supplies `PORT`.
Local development still defaults to loopback. `/health` is the health check path.

Both services use one process and in-memory synthetic records. A service restart
or redeploy clears those records. Use a fresh `/w/<workspace-id>/` workspace for
each test project; the hosted-testing guide supplies a helper for this. Discovery
may create records, so clear only that workspace before executing its approved
protocol. Do not share a workspace between simultaneous test runs.

Free services sleep after 15 idle minutes and can take about a minute to wake.
Their combined running time counts against the workspace's 750 monthly free
instance hours; bandwidth and build allowances also apply. Open each service and
wait for a successful health response before testing. Avoid keep-alive monitors
that consume the allowance unnecessarily. These are disposable test targets,
with no persistence requirement. [Render free-service limits](https://render.com/docs/free)

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Repository not listed in Render | Grant Render's GitHub integration access to this private repository. |
| Successful CI, but no new deploy | Confirm the service follows `main`, the GitHub connection is active, and Auto-Deploy is **After CI Checks Pass**. Check Render's Events page. |
| First request shows a loading page | Wait for the free instance to wake, then retry `/health`. |
| Port detection fails | Confirm `HOST=0.0.0.0`, preserve Render's `PORT`, and use the Blueprint start command. |
| Duplicate IDs or extra CSV rows | Use a new workspace or clear the existing workspace before the run. |
| Records disappear mid-test | Check for a redeploy/restart or workspace expiry; start a fresh run and retain the interrupted evidence. |
| Both services have the same behavior | Compare `/health` mode values and the services' `DILUTION_MODE` settings. |

For local use and the expected four deliberate failures, see the
[Dilution Bench guide](../examples/dilution-app/README.md).
