import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    // Optimize chunk sizes
    chunkSizeWarningLimit: 300,
    // CSS code splitting for parallel loading
    cssCodeSplit: true,
    // Source maps for production debugging
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split framer-motion into its own chunk (heavy animation lib)
          if (id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }

          // Core React runtime
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/")
          ) {
            return "vendor-react";
          }

          // Router in its own chunk
          if (id.includes("node_modules/react-router")) {
            return "vendor-router";
          }

          return undefined;
        },
        // Asset file naming for long-term caching
        assetFileNames(assetInfo) {
          const name = assetInfo.names?.[0] ?? "";
          if (/\.(woff2?|ttf|eot)$/.test(name)) {
            return "assets/fonts/[name]-[hash][extname]";
          }
          if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/.test(name)) {
            return "assets/images/[name]-[hash][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
        chunkFileNames: "assets/js/[name]-[hash].js",
        entryFileNames: "assets/js/[name]-[hash].js"
      }
    },
    // Minification settings
    minify: "esbuild",
    target: "es2022"
  },
  // Optimize dependency pre-bundling
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "framer-motion"
    ]
  }
});
