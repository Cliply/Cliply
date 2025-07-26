import react from "@vitejs/plugin-react"
import path from "path"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: "./", // Use relative paths for Electron compatibility
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    // Disable inline scripts for Electron CSP compatibility
    rollupOptions: {
      output: {
        // Ensure consistent chunk naming
        entryFileNames: `assets/[name].[hash].js`,
        chunkFileNames: `assets/[name].[hash].js`,
        assetFileNames: `assets/[name].[hash].[ext]`
      }
    },
    // Disable inline CSS and JS for CSP compatibility
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    // Generate sourcemaps for debugging
    sourcemap: false,
    // Ensure compatibility with Electron
    target: "esnext",
    minify: "esbuild"
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  }
})
