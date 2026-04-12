import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FORK_REPO = "https://github.com/nickprice101/node-webrtc.git";
const DEFAULT_FORK_REF = "00ce1c2340477568d9ca76fd54659b666a69d767";
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function main() {
  const forkRepo = process.env.WRTC_FORK_REPO || DEFAULT_FORK_REPO;
  const forkRef = process.env.WRTC_FORK_REF || DEFAULT_FORK_REF;
  const wrtcPackageJson = require.resolve("@roamhq/wrtc/package.json", {
    paths: [bridgeRoot],
  });
  const installedWrtcDir = dirname(wrtcPackageJson);
  const binaryDir = join(
    installedWrtcDir,
    `build-${process.platform}-${process.arch}`,
  );
  const builtBinary = join(binaryDir, "wrtc.node");
  const tempRoot = mkdtempSync(join(tmpdir(), "wrtc-fork-"));

  console.log(`[forked-wrtc] installing ${forkRepo} at ${forkRef}`);

  try {
    run("git", ["clone", "--filter=blob:none", forkRepo, tempRoot]);
    run("git", ["checkout", forkRef], { cwd: tempRoot });
    const hasLockfile =
      existsSync(join(tempRoot, "package-lock.json")) ||
      existsSync(join(tempRoot, "npm-shrinkwrap.json"));
    const installArgs = hasLockfile ? ["ci"] : ["install"];
    console.log(
      `[forked-wrtc] using npm ${installArgs[0]}${
        hasLockfile ? " (lockfile detected)" : " (no lockfile present)"
      }`,
    );
    run(NPM_COMMAND, installArgs, { cwd: tempRoot, env: process.env });
    run(NPM_COMMAND, ["run", "build"], { cwd: tempRoot, env: process.env });

    const compiledBinary = join(
      tempRoot,
      `build-${process.platform}-${process.arch}`,
      "wrtc.node",
    );
    if (!existsSync(compiledBinary)) {
      throw new Error(`compiled wrtc binary not found at ${compiledBinary}`);
    }

    mkdirSync(binaryDir, { recursive: true });
    copyFileSync(compiledBinary, builtBinary);
    console.log(`[forked-wrtc] copied ${compiledBinary} -> ${builtBinary}`);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

main();
