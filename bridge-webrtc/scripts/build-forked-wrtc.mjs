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

function replaceInFile(filePath, replacements) {
  const originalContent = readFileSync(filePath, "utf8");
  let updatedContent = originalContent;

  for (const [searchValue, replaceValue] of replacements) {
    if (!updatedContent.includes(searchValue)) {
      throw new Error(`expected to find patch target in ${filePath}`);
    }
    updatedContent = updatedContent.replace(searchValue, replaceValue);
  }

  if (updatedContent !== originalContent) {
    writeFileSync(filePath, updatedContent, "utf8");
  }
}

function resolveWebRtcRevision(forkRoot) {
  const envRevision = process.env.WEBRTC_REVISION?.trim();
  if (envRevision) {
    return envRevision;
  }

  const cmakeListsPath = join(forkRoot, "CMakeLists.txt");
  const cmakeListsContent = readFileSync(cmakeListsPath, "utf8");
  const revisionMatch = cmakeListsContent.match(
    /set\(DEFAULT_WEBRTC_REVISION\s+([^\s)]+)\)/,
  );
  return revisionMatch?.[1] ?? null;
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

function patchUnsupportedLinuxCompilerFlags(forkRoot) {
  if (process.platform !== "linux") {
    return;
  }

  const cmakeListsPath = join(forkRoot, "CMakeLists.txt");
  const content = readFileSync(cmakeListsPath, "utf8");
  const patched = content.replace(
    /^\s*-fsafe-buffer-usage-suggestions\s*$/m,
    "",
  );

  if (patched !== content) {
    writeFileSync(cmakeListsPath, patched, "utf8");
    console.log("[forked-wrtc] removed unsupported -fsafe-buffer-usage-suggestions flag for Linux build");
  }
}

function patchBranchHeads5735Compatibility(forkRoot) {
  if (resolveWebRtcRevision(forkRoot) !== "branch-heads/5735") {
    return;
  }

  replaceInFile(
    join(forkRoot, "src", "interfaces", "rtc_peer_connection", "peer_connection_factory.hh"),
    [
      [
        "#include <webrtc/api/environment/environment.h>\n",
        "",
      ],
      [
        "\n  const webrtc::Environment &env() const { return _env; }\n",
        "\n",
      ],
      [
        "  webrtc::Environment _env;\n",
        "",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "interfaces", "rtc_peer_connection", "peer_connection_factory.cc"),
    [
      [
        "#include <webrtc/api/environment/environment_factory.h>\n",
        "",
      ],
      [
        "PeerConnectionFactory::PeerConnectionFactory(const Napi::CallbackInfo &info)\n    : Napi::ObjectWrap<PeerConnectionFactory>(info),\n      _env(webrtc::CreateEnvironment()) {",
        "PeerConnectionFactory::PeerConnectionFactory(const Napi::CallbackInfo &info)\n    : Napi::ObjectWrap<PeerConnectionFactory>(info) {",
      ],
      [
        "  _networkManager = std::unique_ptr<rtc::NetworkManager>(\n      new rtc::BasicNetworkManager(_env, _workerThread->socketserver()));",
        "  _networkManager = std::unique_ptr<rtc::NetworkManager>(\n      new rtc::BasicNetworkManager(_workerThread->socketserver()));",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "interfaces", "rtc_peer_connection.cc"),
    [
      [
        "  auto portAllocator =\n      std::unique_ptr<webrtc::PortAllocator>(new webrtc::BasicPortAllocator(\n          _factory->env(), _factory->getNetworkManager(),\n          _factory->getSocketFactory()));",
        "  auto portAllocator =\n      std::unique_ptr<webrtc::PortAllocator>(new webrtc::BasicPortAllocator(\n          _factory->getNetworkManager(), _factory->getSocketFactory()));",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "interfaces", "rtc_ice_transport.hh"),
    [
      [
        "  void OnStateChanged(webrtc::IceTransportInternal *);\n  void OnGatheringStateChanged(webrtc::IceTransportInternal *);",
        "  void OnStateChanged(cricket::IceTransportInternal *);\n  void OnGatheringStateChanged(cricket::IceTransportInternal *);",
      ],
      [
        "  webrtc::IceGatheringState _gathering_state =\n      webrtc::IceGatheringState::kIceGatheringNew;",
        "  cricket::IceGatheringState _gathering_state =\n      cricket::kIceGatheringNew;",
      ],
      [
        "  webrtc::IceRole _role = webrtc::IceRole::ICEROLE_UNKNOWN;",
        "  cricket::IceRole _role = cricket::ICEROLE_UNKNOWN;",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "interfaces", "rtc_ice_transport.cc"),
    [
      [
        "          this, [this](webrtc::IceTransportInternal *transport) {",
        "          this, [this](cricket::IceTransportInternal *transport) {",
      ],
      [
        "          this, [this](webrtc::IceTransportInternal *transport) {",
        "          this, [this](cricket::IceTransportInternal *transport) {",
      ],
      [
        "    _gathering_state = webrtc::IceGatheringState::kIceGatheringComplete;",
        "    _gathering_state = cricket::kIceGatheringComplete;",
      ],
      [
        "  _gathering_state = webrtc::IceGatheringState::kIceGatheringComplete;",
        "  _gathering_state = cricket::kIceGatheringComplete;",
      ],
      [
        "void RTCIceTransport::OnStateChanged(webrtc::IceTransportInternal *) {",
        "void RTCIceTransport::OnStateChanged(cricket::IceTransportInternal *) {",
      ],
      [
        "    webrtc::IceTransportInternal *) {",
        "    cricket::IceTransportInternal *) {",
      ],
      [
        "  case webrtc::IceGatheringState::kIceGatheringNew:",
        "  case cricket::kIceGatheringNew:",
      ],
      [
        "  case webrtc::IceGatheringState::kIceGatheringGathering:",
        "  case cricket::kIceGatheringGathering:",
      ],
      [
        "  case webrtc::IceGatheringState::kIceGatheringComplete:",
        "  case cricket::kIceGatheringComplete:",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "enums", "webrtc", "ice_role.hh"),
    [
      [
        "#define ICE_ROLE webrtc::IceRole",
        "#define ICE_ROLE cricket::IceRole",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "binding.cc"),
    [
      [
        "static webrtc::LoggingSeverity parseLogSeverity(const char* value) {",
        "static rtc::LoggingSeverity parseLogSeverity(const char* value) {",
      ],
      [
        "return webrtc::LoggingSeverity::LS_INFO;",
        "return rtc::LS_INFO;",
      ],
      [
        "return webrtc::LoggingSeverity::LS_INFO;",
        "return rtc::LS_INFO;",
      ],
      [
        "return webrtc::LoggingSeverity::LS_VERBOSE;",
        "return rtc::LS_VERBOSE;",
      ],
      [
        "return webrtc::LoggingSeverity::LS_WARNING;",
        "return rtc::LS_WARNING;",
      ],
      [
        "return webrtc::LoggingSeverity::LS_ERROR;",
        "return rtc::LS_ERROR;",
      ],
      [
        "return webrtc::LoggingSeverity::LS_NONE;",
        "return rtc::LS_NONE;",
      ],
      [
        "webrtc::LogMessage::SetLogToStderr(true);",
        "rtc::LogMessage::SetLogToStderr(true);",
      ],
      [
        "webrtc::LogMessage::LogToDebug(severity);",
        "rtc::LogMessage::LogToDebug(severity);",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "webrtc", "packet_socket_factory_with_tls_cert_verifier.hh"),
    [
      [
        "    : public webrtc::PacketSocketFactory {",
        "    : public rtc::PacketSocketFactory {",
      ],
      [
        "      std::unique_ptr<webrtc::PacketSocketFactory> inner);",
        "      std::unique_ptr<rtc::PacketSocketFactory> inner);",
      ],
      [
        "  std::unique_ptr<webrtc::AsyncPacketSocket> CreateUdpSocket(\n      const webrtc::Environment& env,\n      const webrtc::SocketAddress& address,\n      uint16_t min_port,\n      uint16_t max_port) override;\n  std::unique_ptr<webrtc::AsyncListenSocket> CreateServerTcpSocket(\n      const webrtc::Environment& env,\n      const webrtc::SocketAddress& local_address,\n      uint16_t min_port,\n      uint16_t max_port,\n      int opts) override;\n  std::unique_ptr<webrtc::AsyncPacketSocket> CreateClientTcpSocket(\n      const webrtc::Environment& env,\n      const webrtc::SocketAddress& local_address,\n      const webrtc::SocketAddress& remote_address,\n      const webrtc::PacketSocketTcpOptions& tcp_options) override;\n  std::unique_ptr<webrtc::AsyncDnsResolverInterface> CreateAsyncDnsResolver()\n      override;\n  std::unique_ptr<webrtc::AsyncPacketSocket> CreateClientUdpSocket(\n      const webrtc::Environment& env,\n      const webrtc::SocketAddress& local_address,\n      const webrtc::SocketAddress& remote_address,\n      uint16_t min_port,\n      uint16_t max_port,\n      const webrtc::PacketSocketTcpOptions& options) override;",
        "  rtc::AsyncPacketSocket* CreateUdpSocket(\n      const rtc::SocketAddress& address,\n      uint16_t min_port,\n      uint16_t max_port) override;\n  rtc::AsyncListenSocket* CreateServerTcpSocket(\n      const rtc::SocketAddress& local_address,\n      uint16_t min_port,\n      uint16_t max_port,\n      int opts) override;\n  rtc::AsyncPacketSocket* CreateClientTcpSocket(\n      const rtc::SocketAddress& local_address,\n      const rtc::SocketAddress& remote_address,\n      const rtc::ProxyInfo& proxy_info,\n      const std::string& user_agent,\n      const rtc::PacketSocketTcpOptions& tcp_options) override;\n  std::unique_ptr<webrtc::AsyncDnsResolverInterface> CreateAsyncDnsResolver()\n      override;",
      ],
      [
        "  webrtc::PacketSocketTcpOptions WithTlsVerifier(\n      const webrtc::PacketSocketTcpOptions& options) const;\n\n  std::unique_ptr<webrtc::PacketSocketFactory> inner_;\n  std::unique_ptr<webrtc::SSLCertificateVerifier> tls_cert_verifier_;",
        "  rtc::PacketSocketTcpOptions WithTlsVerifier(\n      const rtc::PacketSocketTcpOptions& options) const;\n\n  std::unique_ptr<rtc::PacketSocketFactory> inner_;\n  std::unique_ptr<rtc::SSLCertificateVerifier> tls_cert_verifier_;",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "webrtc", "packet_socket_factory_with_tls_cert_verifier.cc"),
    [
      [
        "    std::unique_ptr<webrtc::PacketSocketFactory> inner)",
        "    std::unique_ptr<rtc::PacketSocketFactory> inner)",
      ],
      [
        "std::unique_ptr<webrtc::AsyncPacketSocket>\nPacketSocketFactoryWithTlsCertVerifier::CreateUdpSocket(\n    const webrtc::Environment& env,\n    const webrtc::SocketAddress& address,\n    uint16_t min_port,\n    uint16_t max_port) {\n  return inner_->CreateUdpSocket(env, address, min_port, max_port);\n}\n\nstd::unique_ptr<webrtc::AsyncListenSocket>\nPacketSocketFactoryWithTlsCertVerifier::CreateServerTcpSocket(\n    const webrtc::Environment& env,\n    const webrtc::SocketAddress& local_address,\n    uint16_t min_port,\n    uint16_t max_port,\n    int opts) {\n  return inner_->CreateServerTcpSocket(env, local_address, min_port, max_port,\n                                       opts);\n}\n\nstd::unique_ptr<webrtc::AsyncPacketSocket>\nPacketSocketFactoryWithTlsCertVerifier::CreateClientTcpSocket(\n    const webrtc::Environment& env,\n    const webrtc::SocketAddress& local_address,\n    const webrtc::SocketAddress& remote_address,\n    const webrtc::PacketSocketTcpOptions& tcp_options) {\n  return inner_->CreateClientTcpSocket(env, local_address, remote_address,\n                                       WithTlsVerifier(tcp_options));\n}",
        "rtc::AsyncPacketSocket*\nPacketSocketFactoryWithTlsCertVerifier::CreateUdpSocket(\n    const rtc::SocketAddress& address,\n    uint16_t min_port,\n    uint16_t max_port) {\n  return inner_->CreateUdpSocket(address, min_port, max_port);\n}\n\nrtc::AsyncListenSocket*\nPacketSocketFactoryWithTlsCertVerifier::CreateServerTcpSocket(\n    const rtc::SocketAddress& local_address,\n    uint16_t min_port,\n    uint16_t max_port,\n    int opts) {\n  return inner_->CreateServerTcpSocket(local_address, min_port, max_port,\n                                       opts);\n}\n\nrtc::AsyncPacketSocket*\nPacketSocketFactoryWithTlsCertVerifier::CreateClientTcpSocket(\n    const rtc::SocketAddress& local_address,\n    const rtc::SocketAddress& remote_address,\n    const rtc::ProxyInfo& proxy_info,\n    const std::string& user_agent,\n    const rtc::PacketSocketTcpOptions& tcp_options) {\n  return inner_->CreateClientTcpSocket(local_address, remote_address,\n                                       proxy_info, user_agent,\n                                       WithTlsVerifier(tcp_options));\n}",
      ],
      [
        "\nstd::unique_ptr<webrtc::AsyncPacketSocket>\nPacketSocketFactoryWithTlsCertVerifier::CreateClientUdpSocket(\n    const webrtc::Environment& env,\n    const webrtc::SocketAddress& local_address,\n    const webrtc::SocketAddress& remote_address,\n    uint16_t min_port,\n    uint16_t max_port,\n    const webrtc::PacketSocketTcpOptions& options) {\n  return inner_->CreateClientUdpSocket(env, local_address, remote_address,\n                                       min_port, max_port,\n                                       WithTlsVerifier(options));\n}\n",
        "\n",
      ],
      [
        "webrtc::PacketSocketTcpOptions\nPacketSocketFactoryWithTlsCertVerifier::WithTlsVerifier(\n    const webrtc::PacketSocketTcpOptions& options) const {",
        "rtc::PacketSocketTcpOptions\nPacketSocketFactoryWithTlsCertVerifier::WithTlsVerifier(\n    const rtc::PacketSocketTcpOptions& options) const {",
      ],
      [
        "(options.opts & webrtc::PacketSocketFactory::OPT_TLS) != 0;",
        "(options.opts & rtc::PacketSocketFactory::OPT_TLS) != 0;",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "webrtc", "windows_platform_certificate_verifier.hh"),
    [
      [
        "std::unique_ptr<webrtc::SSLCertificateVerifier>",
        "std::unique_ptr<rtc::SSLCertificateVerifier>",
      ],
    ],
  );

  replaceInFile(
    join(forkRoot, "src", "webrtc", "windows_platform_certificate_verifier.cc"),
    [
      [
        "    const webrtc::SSLCertificate& certificate) {",
        "    const rtc::SSLCertificate& certificate) {",
      ],
      [
        "    : public webrtc::SSLCertificateVerifier {",
        "    : public rtc::SSLCertificateVerifier {",
      ],
      [
        "  bool VerifyChain(const webrtc::SSLCertChain& chain) override {",
        "  bool VerifyChain(const rtc::SSLCertChain& chain) override {",
      ],
      [
        "std::unique_ptr<webrtc::SSLCertificateVerifier>\nCreateWindowsPlatformCertificateVerifier() {",
        "std::unique_ptr<rtc::SSLCertificateVerifier>\nCreateWindowsPlatformCertificateVerifier() {",
      ],
      [
        "std::unique_ptr<webrtc::SSLCertificateVerifier>\nCreateWindowsPlatformCertificateVerifier() {",
        "std::unique_ptr<rtc::SSLCertificateVerifier>\nCreateWindowsPlatformCertificateVerifier() {",
      ],
    ],
  );

  console.log("[forked-wrtc] patched fork sources for WebRTC M114 compatibility");
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
    patchBranchHeads5735Compatibility(tempRoot);
    patchUnsupportedLinuxCompilerFlags(tempRoot);
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
