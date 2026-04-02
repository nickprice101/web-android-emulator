import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      events: "events",
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "events",
      "@babel/runtime/helpers/interopRequireDefault",
      "android-emulator-webrtc",
      "android-emulator-webrtc/emulator",
    ],
  },
  build: {
    target: "es2020",
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});
