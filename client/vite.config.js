import { defineConfig } from "vite";

/**
 * The activity is served to Discord as a production build by the Node server,
 * so the `build` block is what matters in every real deployment. The `server`
 * block only covers running Vite's dev server behind the tunnel by hand.
 */
export default defineConfig({
  // Relative asset URLs, so the bundle resolves whether Discord serves the
  // activity from the origin root or from under a proxy path prefix.
  base: "./",

  build: {
    outDir: "dist",
    target: "es2022",
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    // Discord's proxy strips cache headers for HTML only, so assets must carry
    // content hashes. One chunk avoids depending on the proxy to serve
    // dynamically-imported chunks correctly.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },

  server: {
    // Bind all interfaces: the tunnel reaches this from another container.
    host: true,
    port: 5173,
    strictPort: true,
    // Vite rejects unknown Host headers, and cloudflared forwards the tunnel
    // hostname verbatim. Acceptable only because the whole zone is disposable
    // dev infrastructure.
    allowedHosts: [".trycloudflare.com"],
    // Discord serves the iframe over 443, so the HMR client must dial that
    // rather than the dev server's port.
    hmr: { clientPort: 443 },
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/.proxy/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
