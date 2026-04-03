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
  <rect x="764" y="14" width="180" height="30" rx="8" fill="#2D4E2F"/>
  <text x="779" y="34" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">Custom WebRTC</text>
  <rect x="16" y="78" width="500" height="790" rx="20" fill="#05070B" stroke="#202634"/>
  <rect x="16" y="78" width="500" height="48" rx="20" fill="#0B1018"/>
  <text x="34" y="108" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="14">Custom WebRTC bridge (low latency)</text>
  <text x="323" y="108" fill="#9DB0CC" font-family="Segoe UI, Arial, sans-serif" font-size="13">bridge: ready | session: connected</text>
  <rect x="42" y="146" width="448" height="688" rx="26" fill="url(#screen)"/>
  <rect x="42" y="766" width="250" height="54" rx="12" fill="#09111C" fill-opacity="0.82"/>
  <text x="58" y="798" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">Peer connection established and video is flowing.</text>
  <rect x="310" y="766" width="154" height="54" rx="12" fill="#09111C" fill-opacity="0.82"/>
  <text x="326" y="790" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">frames: 184</text>
  <text x="326" y="808" fill="#D7DFED" font-family="Segoe UI, Arial, sans-serif" font-size="13">1080x1920</text>
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
  <text x="578" y="376" fill="#D7DFED" font-family="Consolas, monospace" font-size="14">Custom WebRTC session established. Tap and swipe controls are active.</text>
  <rect x="560" y="440" width="842" height="388" rx="12" fill="#111823" stroke="#2B313D"/>
  <text x="578" y="466" fill="#A8B3C7" font-family="Segoe UI, Arial, sans-serif" font-size="13">Android system logs (live, last 100)</text>
  <rect x="578" y="488" width="806" height="292" rx="10" fill="#0F1218" stroke="#2B313D"/>
  <text x="596" y="520" fill="#D7DFED" font-family="Consolas, monospace" font-size="14">04-03 19:36:10.401 I ActivityTaskManager: START u0 {act=android.intent.action.MAIN ...}</text>
  <text x="596" y="546" fill="#D7DFED" font-family="Consolas, monospace" font-size="14">04-03 19:36:11.218 I chromium: [INFO:webrtc] connected via custom bridge</text>
  <text x="596" y="572" fill="#D7DFED" font-family="Consolas, monospace" font-size="14">04-03 19:36:12.007 I InputDispatcher: Delivering pointer event to foreground app</text>
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
