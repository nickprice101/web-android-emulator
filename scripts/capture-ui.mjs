import fs from "node:fs/promises";
import path from "node:path";

const outputArg = process.argv[2];
const outputPath = path.resolve(outputArg || "artifacts/ui-layout.svg");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1440" height="900" viewBox="0 0 1440 900" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1440" height="900" fill="#11151C"/>
  <rect x="0" y="0" width="1440" height="58" fill="#171A21"/>
  <rect x="14" y="14" width="82" height="30" rx="8" fill="#252D3B"/>
  <rect x="106" y="14" width="82" height="30" rx="8" fill="#252D3B"/>
  <rect x="198" y="14" width="82" height="30" rx="8" fill="#252D3B"/>
  <rect x="290" y="14" width="82" height="30" rx="8" fill="#252D3B"/>
  <rect x="382" y="14" width="82" height="30" rx="8" fill="#252D3B"/>
  <rect x="474" y="14" width="110" height="30" rx="8" fill="#252D3B"/>
  <rect x="594" y="14" width="160" height="30" rx="8" fill="#252D3B"/>
  <rect x="764" y="14" width="180" height="30" rx="8" fill="#6B4F1D"/>
  <text x="836" y="34" text-anchor="middle" fill="#F3D9A4" font-family="Segoe UI, Arial, sans-serif" font-size="13">WebRTC Error</text>
  <rect x="16" y="78" width="500" height="790" rx="20" fill="#05070B" stroke="#202634"/>
  <rect x="16" y="78" width="500" height="48" rx="20" fill="#0B1018"/>
  <text x="34" y="108" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="14">Custom WebRTC error state</text>
  <text x="323" y="108" fill="#9DB0CC" font-family="Segoe UI, Arial, sans-serif" font-size="13">bridge: ready | mode: webrtc | fallback: disabled</text>
  <rect x="42" y="146" width="448" height="520" rx="26" fill="url(#screen)"/>
  <rect x="42" y="598" width="250" height="54" rx="12" fill="#09111C" fill-opacity="0.82"/>
  <text x="58" y="630" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">WebRTC failed and the UI keeps the error visible instead of switching modes.</text>
  <rect x="310" y="598" width="154" height="54" rx="12" fill="#09111C" fill-opacity="0.82"/>
  <text x="326" y="622" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">reason: host-only ICE</text>
  <text x="326" y="640" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">display: error banner</text>
  <rect x="538" y="78" width="886" height="790" rx="18" fill="#171A21"/>
  <rect x="560" y="102" width="842" height="86" rx="12" fill="#111823" stroke="#2B313D"/>
  <text x="578" y="126" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Package name</text>
  <rect x="578" y="138" width="650" height="30" rx="8" fill="#0F1218" stroke="#30394A"/>
  <rect x="1242" y="138" width="142" height="30" rx="8" fill="#2D4E2F"/>
  <text x="1292" y="158" text-anchor="middle" fill="#E8F5E9" font-family="Segoe UI, Arial, sans-serif" font-size="13">Launch</text>
  <rect x="560" y="206" width="412" height="92" rx="12" fill="#111823" stroke="#2B313D"/>
  <rect x="990" y="206" width="412" height="92" rx="12" fill="#111823" stroke="#2B313D"/>
  <text x="578" y="232" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Emulator state</text>
  <text x="578" y="266" fill="#3FB950" font-family="Segoe UI, Arial, sans-serif" font-size="28">connected</text>
  <text x="1008" y="232" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Bridge API</text>
  <text x="1008" y="266" fill="#3FB950" font-family="Segoe UI, Arial, sans-serif" font-size="28">ready</text>
  <rect x="560" y="318" width="842" height="104" rx="12" fill="#111823" stroke="#2B313D"/>
  <text x="578" y="344" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Last message</text>
  <text x="578" y="370" fill="#D7DFED" font-family="Consolas, monospace" font-size="13">Custom WebRTC failed because the bridge answer only exposed private</text>
  <text x="578" y="390" fill="#D7DFED" font-family="Consolas, monospace" font-size="13">or loopback ICE candidates and no relay candidate was reachable.</text>
  <rect x="560" y="440" width="842" height="158" rx="12" fill="#111823" stroke="#2B313D"/>
  <text x="578" y="466" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Display diagnostics</text>
  <text x="578" y="494" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">Raw ADB frame endpoint: /api/frame</text>
  <text x="578" y="520" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Emulator screen: 1080x1920</text>
  <text x="578" y="544" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">WebRTC frame: failed fast after host-only ICE answer.</text>
  <text x="578" y="568" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Tip: check TURN reachability and make sure TURN credentials are real deployment values.</text>
  <rect x="1220" y="472" width="146" height="102" rx="10" fill="url(#screen)" stroke="#2B313D"/>
  <text x="1228" y="590" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="11">Raw screencap preview</text>
  <rect x="560" y="616" width="842" height="212" rx="12" fill="#111823" stroke="#2B313D"/>
  <text x="578" y="642" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Custom WebRTC diagnostics</text>
  <text x="578" y="668" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="12">Browser offer: type=offer | candidates=4</text>
  <text x="578" y="688" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="12">Bridge answer: video=sendonly | mid=0 | candidates=3 | codecs=11 | track=6ecbb6d6...</text>
  <text x="578" y="708" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="12">Browser RTP: packets 0 | bytes 0 | frames decoded 0</text>
  <text x="578" y="728" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="12">Bridge states: session failed | ice closed | gathering complete</text>
  <rect x="578" y="742" width="396" height="68" rx="10" fill="#0F1218" stroke="#2B313D"/>
  <text x="594" y="764" fill="#A8B3C7" font-family="Consolas, monospace" font-size="10">[09:26:09] Bridge SDP answer applied in browser {"sendCapableVideo":true}</text>
  <text x="594" y="784" fill="#A8B3C7" font-family="Consolas, monospace" font-size="10">[09:26:30] WebRTC error surfaced {"reason":"host-only ICE"}</text>
  <rect x="988" y="742" width="396" height="68" rx="10" fill="#0F1218" stroke="#2B313D"/>
  <text x="1004" y="764" fill="#A8B3C7" font-family="Consolas, monospace" font-size="10">v=0</text>
  <text x="1004" y="784" fill="#A8B3C7" font-family="Consolas, monospace" font-size="10">m=video 50446 UDP/TLS/RTP/SAVPF 96 97 98 99 100 ...</text>
  <defs>
    <linearGradient id="screen" x1="42" y1="146" x2="490" y2="834" gradientUnits="userSpaceOnUse">
      <stop stop-color="#2B3951"/>
      <stop offset="0.4" stop-color="#182434"/>
      <stop offset="1" stop-color="#081018"/>
    </linearGradient>
  </defs>
</svg>
`;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, svg, "utf8");

console.log(outputPath);
