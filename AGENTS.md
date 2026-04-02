Before performing any edits in this repository:

Ensure the repository matches origin/main.

Run: 

git fetch origin 
git reset --hard origin/main 
git clean -fd

Do not proceed with modifications until the repo is synced.

UI screenshots should be captured via Playwright (headless) and attached as an artifact.
For environemnts where browser_container (or equivalent) is unavailable, a static layout screenshot should be generated using scripts/capture-ui.mjs.
