import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FORK_REPO = "https://github.com/nickprice101/node-webrtc.git";
const DEFAULT_FORK_REF = "00ce1c2340477568d9ca76fd54659b666a69d767";
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const DEFAULT_NIX_GNI = [
  "is_clang=true",
  "use_lld=false",
  "clang_use_chrome_plugins=false",
  "",
].join("\n");
const WRAPPER_SCRIPT_MODE = 0o755;

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

function ensureGeneratedForkFiles(forkRoot) {
  const nixGniPath = join(forkRoot, "nix.gni");
  if (!existsSync(nixGniPath)) {
    writeFileSync(nixGniPath, DEFAULT_NIX_GNI, "utf8");
    console.log(`[forked-wrtc] wrote missing ${nixGniPath}`);
  }
}

function normalizeShellScriptLineEndings(rootDir) {
  let normalizedCount = 0;

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      const entryPath = join(currentDir, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (!entryPath.endsWith(".sh")) {
        continue;
      }

      const content = readFileSync(entryPath, "utf8");
      if (!content.includes("\r")) {
        continue;
      }

      writeFileSync(entryPath, content.replace(/\r\n/g, "\n"), "utf8");
      normalizedCount += 1;
    }
  }

  walk(rootDir);

  if (normalizedCount > 0) {
    console.log(`[forked-wrtc] normalized line endings for ${normalizedCount} shell script(s)`);
  }
}

function prepareLinuxCompilerWrappers(forkRoot) {
  if (process.platform !== "linux") {
    return process.env;
  }

  const buildDir = join(
    forkRoot,
    `build-${process.platform}-${process.arch}`,
    "external",
    "libwebrtc",
    "download",
    "src",
    "third_party",
    "llvm-build",
    "Release+Asserts",
    "bin",
  );
  const wrapperDir = join(forkRoot, ".codex-compiler");
  const compilerNames = [
    ["clang", "CC"],
    ["clang++", "CXX"],
  ];

  mkdirSync(wrapperDir, { recursive: true });

  for (const [compilerName] of compilerNames) {
    const wrapperPath = join(wrapperDir, compilerName);
    const script = [
      "#!/usr/bin/env bash",
      "set -e",
      `CHROMIUM_CLANG="${join(buildDir, compilerName).replace(/\\/g, "/")}"`,
      `if [ -x "${"$"}CHROMIUM_CLANG" ]; then`,
      `  exec "${"$"}CHROMIUM_CLANG" "${"$"}@"`,
      "fi",
      `if command -v ${compilerName} >/dev/null 2>&1; then`,
      `  exec ${compilerName} "${"$"}@"`,
      "fi",
      `exec ${compilerName === "clang++" ? "c++" : "cc"} "${"$"}@"`,
      "",
    ].join("\n");
    writeFileSync(wrapperPath, script, "utf8");
    chmodSync(wrapperPath, WRAPPER_SCRIPT_MODE);
  }

  console.log(`[forked-wrtc] prepared Linux compiler wrappers in ${wrapperDir}`);

  return {
    ...process.env,
    CC: join(wrapperDir, "clang"),
    CXX: join(wrapperDir, "clang++"),
  };
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
    ensureGeneratedForkFiles(tempRoot);
    normalizeShellScriptLineEndings(tempRoot);
    const buildEnv = prepareLinuxCompilerWrappers(tempRoot);
    const hasLockfile =
      existsSync(join(tempRoot, "package-lock.json")) ||
      existsSync(join(tempRoot, "npm-shrinkwrap.json"));
    const installArgs = hasLockfile ? ["ci"] : ["install"];
    console.log(
      `[forked-wrtc] using npm ${installArgs[0]}${
        hasLockfile ? " (lockfile detected)" : " (no lockfile present)"
      }`,
    );
    run(NPM_COMMAND, installArgs, { cwd: tempRoot, env: buildEnv });
    run(NPM_COMMAND, ["run", "build"], { cwd: tempRoot, env: buildEnv });

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
