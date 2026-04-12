# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: native-turns-video.spec.mjs >> native emulator stream renders real video frames over deployed turns path
- Location: tests/e2e/native-turns-video.spec.mjs:43:1

# Error details

```
Error: Expected usable video, got {"outcome":"failed","videoStats":{"readyState":4,"currentTime":0,"videoWidth":2,"videoHeight":2,"totalVideoFrames":1,"droppedVideoFrames":0}}

expect(received).toBe(expected) // Object.is equality

Expected: "ready"
Received: "failed"
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - button "Back" [ref=e5]
    - button "Home" [ref=e6]
    - button "Recents" [ref=e7]
    - button "Wake" [ref=e8]
    - button "Reboot" [ref=e9]
    - button "Fullscreen" [ref=e10]
    - button "Reconnect" [ref=e11]
    - button "Browse APKs" [ref=e12]
    - generic [ref=e13]:
      - text: Stream
      - combobox "Stream" [ref=e14]:
        - option "WebRTC (native emulator)" [selected]
    - button "Choose File" [ref=e15]
    - textbox "APK path under workspace" [ref=e16]
  - generic [ref=e23]:
    - generic [ref=e24]:
      - generic [ref=e25]: Package name
      - generic [ref=e26]:
        - textbox "com.example.app" [ref=e27]
        - button "Launch" [disabled] [ref=e28]
    - generic [ref=e29]:
      - generic [ref=e30]:
        - generic [ref=e31]: Emulator state
        - generic [ref=e32]: disconnected
      - generic [ref=e33]:
        - generic [ref=e34]: Bridge API
        - generic [ref=e35]: ready
    - generic [ref=e36]:
      - generic [ref=e37]: Last message
      - generic [ref=e38]: Bridge API ready
    - generic [ref=e39]:
      - generic [ref=e40]: Display diagnostics
      - generic [ref=e41]:
        - generic [ref=e42]: "Emulator screen: 1080x1920"
        - generic [ref=e43]: "WebRTC frame: native WebRTC disconnected | The native emulator session dropped before the browser rendered a usable frame. | Browser video readyState 4 | size 2x2 | RTP packets 0 | decoded 0 | If TURN used to work and now shows no allocations, inspect the emulator's native ICE/TURN advertisement rather than the old bridge path."
        - generic [ref=e44]: Native WebRTC stays front and center here while we debug the emulator's built-in RTC path.
    - generic [ref=e45]:
      - generic [ref=e46]: Native WebRTC diagnostics
      - generic [ref=e47]:
        - generic [ref=e48]: "Transport: native emulator WebRTC / gRPC-Web"
        - generic [ref=e49]: "Mode: native WebRTC disconnected"
        - generic [ref=e50]: The native emulator session dropped before the browser rendered a usable frame.
        - generic [ref=e51]: Browser video readyState 4 | size 2x2 | RTP packets 0 | decoded 0 | If TURN used to work and now shows no allocations, inspect the emulator's native ICE/TURN advertisement rather than the old bridge path.
        - generic [ref=e52]: "Native upstream sending video: no (no inbound RTP/video counters yet)"
        - generic [ref=e53]: "Diagnosis: The native emulator session dropped before the browser rendered a usable frame."
        - generic [ref=e54]: "ICE servers: urls=1 | turn=yes | stun=no | first=turns:turn.corsicanescape.com:443?transport=tcp"
        - generic [ref=e55]: "Candidate path: local total 2 | relay 2 | host 0 | srflx 0 | prflx 0 | remote total 9 | relay 0 | host 6 | srflx 3 | prflx 0"
        - generic [ref=e56]: "Selected pair: none"
      - generic [ref=e57]:
        - generic [ref=e58]:
          - generic [ref=e59]: First-frame path
          - generic [ref=e60]: "emu=disconnected | browserVideo=4 | size=2x2 start ice servers: urls=1 | turn=yes | stun=no | first=turns:turn.corsicanescape.com:443?transport=tcp turn advertisement: present or not yet known local candidates: total 2 | relay 2 | host 0 | srflx 0 | prflx 0 remote candidates: total 9 | relay 0 | host 6 | srflx 3 | prflx 0 peer states: connection=closed | ice=closed | signaling=closed | gathering=complete peer stats: packets=0 | bytes=0 | framesReceived=0 | framesDecoded=0 | fps=n/a selected pair: none diagnosis: The native emulator session dropped before the browser rendered a usable frame. last error: none"
        - generic [ref=e61]:
          - generic [ref=e62]: Browser runtime events
          - generic [ref=e63]: "[9:44:56 AM] Loaded bridge ICE fallback configuration {\"iceServers\":1,\"hasTurn\":true,\"hasStun\":false} [9:44:56 AM] Native emulator advertised RTC configuration {\"iceServers\":1,\"hasTurn\":true,\"hasStun\":false,\"injectedIce\":false,\"iceTransportPolicy\":\"relay\"} [9:44:56 AM] Forcing native browser ICE transport policy to relay because TURN is configured [9:44:56 AM] Attached native WebRTC diagnostics to browser peer connection [9:44:56 AM] Native ICE connection state changed {\"state\":\"checking\"} [9:44:56 AM] Native browser ICE candidate gathered {\"candidate\":\"candidate:912987198 1 udp 8191 83.85.170.147 49168 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag O2co network-cost 999\"} [9:44:56 AM] Native peer connection state changed {\"state\":\"connecting\"} [9:44:56 AM] Native browser ICE candidate gathered {\"candidate\":\"candidate:912987198 1 udp 8191 83.85.170.147 49180 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag O2co network-cost 999\"} [9:44:56 AM] Native ICE gathering state changed {\"state\":\"complete\"} [9:44:56 AM] Native browser ICE gathering completed [9:45:12 AM] Native ICE connection state changed {\"state\":\"disconnected\"} [9:45:12 AM] Native JSEP session disconnected [9:45:12 AM] Native peer connection state changed {\"state\":\"closed\"} [9:45:12 AM] Native video element suspended [9:45:12 AM] Native video element resized {\"width\":2,\"height\":2} [9:45:12 AM] Native video element loaded metadata {\"width\":2,\"height\":2} [9:45:12 AM] Native video element loaded current frame data {\"readyState\":4} [9:45:12 AM] Native video element can play {\"readyState\":4} [9:45:12 AM] Native video element resized {\"width\":2,\"height\":2} [9:45:12 AM] Native video element started playing"
    - generic [ref=e64]:
      - generic [ref=e65]: Android system logs (live, last 100)
      - generic [ref=e66]:
        - textbox "Filter text (e.g. package name)" [ref=e67]
        - generic [ref=e68]:
          - checkbox "Errors only" [ref=e69]
          - text: Errors only
        - generic [ref=e70]:
          - checkbox "FATAL" [ref=e71]
          - text: FATAL
        - generic [ref=e72]:
          - text: Rows
          - spinbutton "Rows" [ref=e73]: "100"
        - button "Pause logs" [ref=e74]
        - button "Clear" [ref=e75]
      - generic [ref=e76]: "04-12 09:43:52.062 I/PairHttpConnection( 3835): [Upload] Connected 04-12 09:43:52.063 W/LocationOracle( 3835): No location history returned by ContextManager 04-12 09:43:52.065 W/CronetNetworkRqstWrppr( 3835): Upload request without a content type. 04-12 09:43:52.066 E/SmartspaceUpdateOEMInte( 3835): Unable to find the right card to send or chip, abort 04-12 09:43:12.194 W/ActivityManager( 532): Background start not allowed: service Intent { cmp=com.google.android.apps.messaging/.shared.datamodel.action.execution.ActionExecutorImpl$EmptyService } to com.google.android.apps.messaging/.shared.datamodel.action.execution.ActionExecutorImpl$EmptyService from pid=7739 uid=10131 pkg=com.google.android.apps.messaging startFg?=false 04-12 09:43:52.067 D/CompatibilityChangeReporter( 532): Compat change id reported: 135634846; UID 10072; state: DISABLED 04-12 09:43:52.067 D/CompatibilityChangeReporter( 532): Compat change id reported: 143937733; UID 10072; state: ENABLED 04-12 09:43:52.068 D/StrictMode( 3835): StrictMode policy violation: android.os.strictmode.DiskReadViolation 04-12 09:43:52.068 D/StrictMode( 3835): at android.os.StrictMode$AndroidBlockGuardPolicy.onReadFromDisk(StrictMode.java:1596) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.sqlite.SQLiteConnection.applyBlockGuardPolicy(SQLiteConnection.java:1197) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.sqlite.SQLiteConnection.executeForCursorWindow(SQLiteConnection.java:998) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.sqlite.SQLiteSession.executeForCursorWindow(SQLiteSession.java:838) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.sqlite.SQLiteQuery.fillWindow(SQLiteQuery.java:62) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.sqlite.SQLiteCursor.fillWindow(SQLiteCursor.java:153) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.sqlite.SQLiteCursor.getCount(SQLiteCursor.java:140) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.CursorToBulkCursorAdaptor.getBulkCursorDescriptor(CursorToBulkCursorAdaptor.java:161) 04-12 09:43:52.068 D/StrictMode( 3835): at android.content.ContentProviderNative.onTransact(ContentProviderNative.java:116) 04-12 09:43:52.068 D/StrictMode( 3835): at android.os.Binder.execTransactInternal(Binder.java:1154) 04-12 09:43:52.068 D/StrictMode( 3835): at android.os.Binder.execTransact(Binder.java:1123) 04-12 09:43:52.068 D/StrictMode( 3835): # via Binder call with stack: 04-12 09:43:52.068 D/StrictMode( 3835): at android.os.StrictMode.readAndHandleBinderCallViolations(StrictMode.java:2358) 04-12 09:43:52.068 D/StrictMode( 3835): at android.os.Parcel.readExceptionCode(Parcel.java:2318) 04-12 09:43:52.068 D/StrictMode( 3835): at android.database.DatabaseUtils.readExceptionFromParcel(DatabaseUtils.java:139) 04-12 09:43:52.068 D/StrictMode( 3835): at android.content.ContentProviderProxy.query(ContentProviderNative.java:472) 04-12 09:43:52.068 D/StrictMode( 3835): at android.content.ContentResolver.query(ContentResolver.java:1183) 04-12 09:43:52.068 D/StrictMode( 3835): at android.content.ContentResolver.query(ContentResolver.java:1115) 04-12 09:43:52.068 D/StrictMode( 3835): at android.content.ContentResolver.query(ContentResolver.java:1071) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.h.b.a(SourceFile:1) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.search.core.google.az.a(SourceFile:6) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.search.core.google.az.d(SourceFile:2) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.search.core.google.bj.a(SourceFile:6) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.search.core.google.cb.a(SourceFile:215) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.search.core.google.cb.a(SourceFile:199) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.search.core.google.cb.c(SourceFile:192) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.staticplugins.i.e.a(SourceFile:23) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.staticplugins.i.b.b.a(Unknown Source:1) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.libraries.gsa.l.a.m.call(Unknown Source:2) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.shared.logger.g.a.a.l.a(SourceFile:13) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.android.apps.gsa.shared.logger.g.a.a.d.call(Unknown Source:4) 04-12 09:43:52.068 D/StrictMode( 3835): at java.util.concurrent.FutureTask.run(FutureTask.java:266) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.apps.tiktok.concurrent.aq.run(SourceFile:1) 04-12 09:43:52.068 D/StrictMode( 3835): at java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1167) 04-12 09:43:52.068 D/StrictMode( 3835): at java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:641) 04-12 09:43:52.068 D/StrictMode( 3835): at com.google.apps.tiktok.concurrent.f.run(Unknown Source:3) 04-12 09:43:52.068 D/StrictMode( 3835): at java.lang.Thread.run(Thread.java:923) 04-12 09:43:52.069 W/LocationOracle( 3835): getBestLocation(): no location is available 04-12 09:43:52.069 W/GCoreFlp( 1249): No location to return for getLastLocation() 04-12 09:43:52.071 W/LocationOracle( 3835): No location returned by GMS core getLastLocation() 04-12 09:43:52.082 D/Zygote ( 304): Forked child process 7919 04-12 09:43:52.083 I/ActivityManager( 532): Start proc 7919:com.android.providers.calendar/u0a72 for content provider {com.android.providers.calendar/com.android.providers.calendar.CalendarProvider2} 04-12 09:43:52.085 W/viders.calenda( 7919): Unexpected CPU variant for X86 using defaults: x86_64 04-12 09:43:52.087 I/adbd ( 406): jdwp connection from 7919 04-12 09:43:52.090 D/WifiNl80211Manager( 532): Scan result ready event 04-12 09:43:52.090 D/WifiNative( 532): Scan result ready event 04-12 09:43:52.091 I/viders.calenda( 7919): The ClassLoaderContext is a special shared library. 04-12 09:43:52.093 D/NetworkSecurityConfig( 7919): No Network Security Config specified, using platform default 04-12 09:43:52.093 D/NetworkSecurityConfig( 7919): No Network Security Config specified, using platform default 04-12 09:43:52.096 I/CalendarProvider2( 7919): Created com.android.providers.calendar.CalendarAlarmManager@6d1be79(com.android.providers.calendar.CalendarProvider2@9ed27be) 04-12 09:43:52.112 I/PairHttpConnection( 3835): [Download] starting read 04-12 09:43:52.277 W/CPDataMediator( 3835): Failed to get primary cards from work profile 04-12 09:43:52.277 W/CPDataMediator( 3835): com.google.android.enterprise.profileaware.b.c: No profile available 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.enterprise.profileaware.l.g(SourceFile:63) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.enterprise.profileaware.l.e(SourceFile:53) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.enterprise.profileaware.l.c(SourceFile:12) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.enterprise.profileaware.l.a(SourceFile:26) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.apps.gsa.staticplugins.opa.smartspace.crossprofile.aa.a(SourceFile:6) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.apps.gsa.staticplugins.opa.smartspace.crossprofile.f.a(SourceFile:26) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.apps.gsa.staticplugins.opa.smartspace.crossprofile.m.a(SourceFile:11) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.apps.gsa.staticplugins.opa.smartspace.k.k.a(Unknown Source:1) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.libraries.gsa.l.a.p.a(Unknown Source:2) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.apps.gsa.shared.logger.g.a.a.l.a(SourceFile:8) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.android.apps.gsa.shared.logger.g.a.a.h.a(Unknown Source:4) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.common.v.a.f.a(SourceFile:3) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.common.v.a.h.run(SourceFile:21) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.common.v.a.co.run(SourceFile:1) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.apps.tiktok.concurrent.aq.run(SourceFile:1) 04-12 09:43:52.277 W/CPDataMediator( 3835): at java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1167) 04-12 09:43:52.277 W/CPDataMediator( 3835): at java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:641) 04-12 09:43:52.277 W/CPDataMediator( 3835): at com.google.apps.tiktok.concurrent.f.run(Unknown Source:3) 04-12 09:43:52.277 W/CPDataMediator( 3835): at java.lang.Thread.run(Thread.java:923) 04-12 09:43:52.289 D/ProtoStore( 1012): no cached data 04-12 09:42:57.511 W/healthd ( 0): battery l=100 v=5000 t=25.0 h=2 st=2 c=900000 fc=300000 cc=10 chg=a 04-12 09:43:57.511 W/healthd ( 0): battery l=100 v=5000 t=25.0 h=2 st=2 c=900000 fc=300000 cc=10 chg=a 04-12 09:44:00.001 D/KeyguardClockSwitch( 779): Updating clock: 944 04-12 09:44:15.965 V/BackupManagerService( 532): [UserID:0] Scheduling immediate backup pass 04-12 09:44:15.965 W/BackupManagerService( 532): [UserID:0] Backup pass but enabled=false setupComplete=true 04-12 09:44:15.965 I/ActivityManager( 532): Killing 2927:com.google.android.partnersetup/u0a96 (adj 995): empty for 3543s 04-12 09:44:15.968 I/Zygote ( 304): Process 2927 exited due to signal 9 (Killed) 04-12 09:44:15.985 I/libprocessgroup( 532): Successfully killed process cgroup uid 10096 pid 2927 in 19ms 04-12 09:44:24.496 E/netmgr ( 510): qemu_pipe_open_ns:62: Could not connect to the 'pipe:qemud:network' service: Invalid argument 04-12 09:44:24.496 E/netmgr ( 510): Failed to open QEMU pipe 'qemud:network': Invalid argument 04-12 09:44:39.629 E/wifi_forwarder( 512): qemu_pipe_open_ns:62: Could not connect to the 'pipe:qemud:wififorward' service: Invalid argument 04-12 09:44:39.629 E/wifi_forwarder( 512): RemoteConnection failed to initialize: RemoteConnection failed to open pipe 04-12 09:44:54.496 D/logd ( 0): logdr: UID=2000 GID=2000 PID=7953 n tail=0 logMask=99 pid=0 start=0ns timeout=0ns 04-12 09:44:54.451 I/cmd ( 7959): oneway function results will be dropped but finished with status OK and parcel size 4 04-12 09:44:54.455 I/cmd ( 7957): oneway function results will be dropped but finished with status OK and parcel size 4 04-12 09:44:54.456 I/adbd ( 406): host-29: read thread spawning 04-12 09:44:54.456 I/adbd ( 406): host-29: write thread spawning --------- crash buffer --------- ok"
      - generic "Resize log window" [ref=e77]
```

# Test source

```ts
  18  |     ended: video.ended,
  19  |     videoWidth: video.videoWidth,
  20  |     videoHeight: video.videoHeight,
  21  |     totalVideoFrames: playbackQuality?.totalVideoFrames ?? null,
  22  |     droppedVideoFrames: playbackQuality?.droppedVideoFrames ?? null,
  23  |   };
  24  | }
  25  | 
  26  | async function readBodyText(page) {
  27  |   return page.locator("body").innerText();
  28  | }
  29  | 
  30  | function readFieldFromBody(bodyText, heading) {
  31  |   const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  32  |   const pattern = new RegExp(`${escapedHeading}\\s+([^\\n]+)`, "i");
  33  |   return bodyText.match(pattern)?.[1]?.trim() ?? "";
  34  | }
  35  | 
  36  | function readSectionFromBody(bodyText, heading, nextHeading) {
  37  |   const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  38  |   const escapedNextHeading = nextHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  39  |   const pattern = new RegExp(`${escapedHeading}\\s+([\\s\\S]*?)\\s+${escapedNextHeading}`, "i");
  40  |   return bodyText.match(pattern)?.[1]?.trim() ?? "";
  41  | }
  42  | 
  43  | test("native emulator stream renders real video frames over deployed turns path", async ({ page }, testInfo) => {
  44  |   await page.goto("/", { waitUntil: "domcontentloaded" });
  45  | 
  46  |   await expect(page.getByText("Emulator state", { exact: true })).toBeVisible({
  47  |     timeout: VIDEO_WAIT_TIMEOUT_MS,
  48  |   });
  49  |   await expect(page.getByText("Native WebRTC diagnostics", { exact: true })).toBeVisible({
  50  |     timeout: VIDEO_WAIT_TIMEOUT_MS,
  51  |   });
  52  | 
  53  |   const nativeVideo = page.locator("video").first();
  54  |   await expect(nativeVideo).toBeVisible({ timeout: VIDEO_WAIT_TIMEOUT_MS });
  55  | 
  56  |   const mediaOutcomeHandle = await page.waitForFunction(
  57  |     ({ minDimension }) => {
  58  |       const video = document.querySelector("video");
  59  |       const bodyText = document.body?.innerText ?? "";
  60  |       const failureDetected =
  61  |         bodyText.includes("The native emulator session dropped before the browser rendered a usable frame.") ||
  62  |         bodyText.includes("Mode: native WebRTC disconnected");
  63  | 
  64  |       if (!(video instanceof HTMLVideoElement)) {
  65  |         return failureDetected ? { outcome: "failed", videoStats: null } : null;
  66  |       }
  67  | 
  68  |       const playbackQuality =
  69  |         typeof video.getVideoPlaybackQuality === "function"
  70  |           ? video.getVideoPlaybackQuality()
  71  |           : null;
  72  |       const videoStats = {
  73  |         readyState: video.readyState,
  74  |         currentTime: video.currentTime,
  75  |         videoWidth: video.videoWidth,
  76  |         videoHeight: video.videoHeight,
  77  |         totalVideoFrames: playbackQuality?.totalVideoFrames ?? 0,
  78  |         droppedVideoFrames: playbackQuality?.droppedVideoFrames ?? 0,
  79  |       };
  80  | 
  81  |       const ready =
  82  |         video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
  83  |         video.videoWidth >= minDimension &&
  84  |         video.videoHeight >= minDimension &&
  85  |         (videoStats.totalVideoFrames > 0 || video.currentTime > 0);
  86  | 
  87  |       if (ready) {
  88  |         return { outcome: "ready", videoStats };
  89  |       }
  90  | 
  91  |       if (failureDetected) {
  92  |         return { outcome: "failed", videoStats };
  93  |       }
  94  | 
  95  |       return null;
  96  |     },
  97  |     { minDimension: MIN_RENDERABLE_VIDEO_DIMENSION },
  98  |     { timeout: VIDEO_WAIT_TIMEOUT_MS }
  99  |   );
  100 | 
  101 |   const mediaOutcome = await mediaOutcomeHandle.jsonValue();
  102 |   const bodyText = await readBodyText(page);
  103 |   const emulatorState = readFieldFromBody(bodyText, "Emulator state");
  104 |   const bridgeApiState = readFieldFromBody(bodyText, "Bridge API");
  105 |   const lastMessage = readSectionFromBody(bodyText, "Last message", "Display diagnostics");
  106 |   const nativeDiagnosticsText = readSectionFromBody(
  107 |     bodyText,
  108 |     "Native WebRTC diagnostics",
  109 |     "First-frame path"
  110 |   );
  111 |   const videoStats = await nativeVideo.evaluate(extractVideoStats);
  112 |   const browserDiagnostics = await page.evaluate(() => window.__EMU_E2E__ || null);
  113 |   const selectedPairUsesRelay =
  114 |     browserDiagnostics?.selectedCandidatePair?.localCandidateType === "relay" ||
  115 |     browserDiagnostics?.selectedCandidatePair?.remoteCandidateType === "relay" ||
  116 |     /Selected pair:\s+.*relay/i.test(nativeDiagnosticsText);
  117 | 
> 118 |   expect(mediaOutcome?.outcome, `Expected usable video, got ${JSON.stringify(mediaOutcome)}`).toBe("ready");
      |                                                                                               ^ Error: Expected usable video, got {"outcome":"failed","videoStats":{"readyState":4,"currentTime":0,"videoWidth":2,"videoHeight":2,"totalVideoFrames":1,"droppedVideoFrames":0}}
  119 |   expect(emulatorState.toLowerCase()).toContain("connected");
  120 |   expect(bridgeApiState.toLowerCase()).toContain("ready");
  121 |   expect(videoStats.readyState).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  122 |   expect(videoStats.videoWidth).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  123 |   expect(videoStats.videoHeight).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  124 |   expect(
  125 |     (videoStats.totalVideoFrames ?? 0) > 0 || videoStats.currentTime > 0,
  126 |     `Expected decoded frames or playback progress, got ${JSON.stringify(videoStats)}`
  127 |   ).toBeTruthy();
  128 |   expect(nativeDiagnosticsText).toContain("Transport: native emulator WebRTC");
  129 |   expect(
  130 |     selectedPairUsesRelay,
  131 |     `Expected selected ICE candidate pair to use TURN relay, got ${JSON.stringify(browserDiagnostics)}`
  132 |   ).toBeTruthy();
  133 | 
  134 |   const diagnosticsPayload = {
  135 |     emulatorState,
  136 |     bridgeApiState,
  137 |     lastMessage,
  138 |     nativeDiagnosticsText,
  139 |     browserDiagnostics,
  140 |     videoStats,
  141 |     testedAt: new Date().toISOString(),
  142 |     baseUrl: testInfo.project.use.baseURL,
  143 |   };
  144 | 
  145 |   await fs.writeFile(
  146 |     testInfo.outputPath("native-turns-video-diagnostics.json"),
  147 |     JSON.stringify(diagnosticsPayload, null, 2),
  148 |     "utf8"
  149 |   );
  150 | 
  151 |   await page.screenshot({
  152 |     path: testInfo.outputPath("native-turns-video.png"),
  153 |     fullPage: true,
  154 |   });
  155 | });
  156 | 
```