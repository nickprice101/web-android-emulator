import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^android-emulator-webrtc$/, replacement: "android-emulator-webrtc/dist/index.js" },
      { find: "events", replacement: "events" },
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "events",
      "@babel/runtime/helpers/interopRequireDefault",
    ],
  },
  build: {
    target: "es2020",
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});
