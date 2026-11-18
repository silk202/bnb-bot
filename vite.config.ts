import { vlyPlugin } from "@vly-ai/integrations";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";
import pkg from "./package.json";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), vlyPlugin(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Force a single copy of React across all packages (including vlyPlugin).
    // Without this, @vly-ai/integrations can resolve its own React copy, which
    // triggers "Invalid hook call" errors at runtime.
    dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  },
  build: {
    // Enable source maps for better debugging (disable in production if needed)
    sourcemap: false,
    // Skip the post-build gzip sizing pass — it re-reads and compresses every
    // chunk for a cosmetic report column, which is pure CPU/RAM overhead in
    // memory-capped deploy containers (the "Killed" deploy builds).
    reportCompressedSize: false,
    // Optimize chunk splitting
    rollupOptions: {
      output: {
        // Manual chunk splitting for better caching and lazy loading
        manualChunks: {
          // Vendor chunks for large libraries
          'react-vendor': ['react', 'react-dom', 'react-router'],
          'convex-vendor': ['convex'],
          // Large UI library chunks
          'radix-ui': [
            '@radix-ui/react-accordion',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-avatar',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-context-menu',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-hover-card',
            '@radix-ui/react-label',
            '@radix-ui/react-menubar',
            '@radix-ui/react-navigation-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-progress',
            '@radix-ui/react-radio-group',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slider',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toggle',
            '@radix-ui/react-toggle-group',
            '@radix-ui/react-tooltip',
          ],
          // Heavy optional libraries - separate chunks for better lazy loading
          'framer-motion': ['framer-motion'],
          'charts': ['recharts'],
          'forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
        // Optimize chunk size
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // Increase chunk size warning limit for better chunking
    chunkSizeWarningLimit: 1000,
    // Target modern browsers for better optimization
    target: 'esnext',
    // Minify options - using esbuild (faster than terser)
    minify: 'esbuild',
  },
  // Optimize dependencies
  optimizeDeps: {
    // Only scan the app entry HTML; avoids crawling unrelated *.html files
    // if a legacy snapshot accidentally contains leaked package folders.
    entries: ['index.html'],
    // Hold ALL dep discovery until the entry crawl finishes so the esbuild
    // optimizer runs exactly ONCE per cold start. Serving dep chunks while
    // re-optimization restarts is what destabilized the preview: the managed
    // session died mid-serving of framer-motion/sonner/snapdom chunks with
    // the deps cache still cold.
    holdUntilCrawlEnd: true,
    // Explicit, complete include list — the app's full package graph
    // discovered ahead of time from src/ + the Vly toolbar, so the FIRST
    // optimization pass is the final one. The browser can then never trigger
    // a mid-session re-bundle server restart. Keep in sync with imports in
    // src/ and vly-toolbar-readonly.tsx.
    include: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      'react-router',
      '@convex-dev/auth/react',
      'convex/react',
      'lucide-react',
      'sonner',
      'next-themes',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
      'cmdk',
      'vaul',
      'input-otp',
      'embla-carousel-react',
      'react-resizable-panels',
      'react-hook-form',
      'react-day-picker',
      'date-fns',
      'recharts',
      'framer-motion',
      'viem',
      'viem/accounts',
      '@zumer/snapdom',
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-aspect-ratio',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-context-menu',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-hover-card',
      '@radix-ui/react-label',
      '@radix-ui/react-menubar',
      '@radix-ui/react-navigation-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slider',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toggle',
      '@radix-ui/react-toggle-group',
      '@radix-ui/react-tooltip',
      '@solana/web3.js',
      'buffer',
      '@scure/base',
      '@scure/bip39',
      '@scure/bip39/wordlists/english.js',
      '@noble/curves/ed25519.js',
      '@noble/hashes/hmac.js',
      '@noble/hashes/sha2.js',
    ],
    esbuildOptions: {
      // Dev-only dep bundles never need source maps; skipping them keeps the
      // single cold-start pass lighter on small containers.
      sourcemap: false,
    },
  },
  // Performance hints
  server: {
    // Bind to all interfaces so WebContainer's server-ready event fires.
    host: true,
    port: 5173,
    // Freebuff managed sessions require HMR to be fully disabled — a plain
    // `false`, never an options object. The preview reloads whole-page
    // between turns, so hot-module sockets are unnecessary (and keeping an
    // HMR server alive is one more thing that can race during sandbox
    // generation changes).
    hmr: false,
    // Transform the full app graph at STARTUP instead of on the first
    // browser request — the crawler follows main.tsx through every lazy
    // route, so the optimizer finishes warming before anyone connects and
    // the browser always lands on a ready server.
    warmup: {
      clientFiles: ['./src/main.tsx'],
    },
  },
});
