import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig({
  base: "/app/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      scope: "/app/",
      manifest: {
        name: "Odysseus Tasks",
        short_name: "Tasks",
        start_url: "/app/",
        scope: "/app/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        icons: [],
      },
      workbox: {
        navigateFallback: "/app/index.html",
        globPatterns: ["**/*.{js,css,html}"],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:7000",
    },
  },
});
