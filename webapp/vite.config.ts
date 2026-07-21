import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig({
  base: "/app-assets/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      manifest: {
        name: "Odysseus Tasks",
        short_name: "Odysseus",
        start_url: "/app-assets/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        icons: [],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:7000",
    },
  },
});
