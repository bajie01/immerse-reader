import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { copyFileSync, mkdirSync, existsSync } from "fs";

function copyAsset(src: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        content: resolve(__dirname, "src/content/index.ts"),
        background: resolve(__dirname, "src/background/service-worker.ts"),
        popup: resolve(__dirname, "src/popup/popup.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  plugins: [
    {
      name: "copy-assets",
      closeBundle() {
        const dest = resolve(__dirname, "dist");
        const srcRoot = resolve(__dirname, "src");

        copyAsset(resolve(__dirname, "manifest.json"), resolve(dest, "manifest.json"));
        copyAsset(resolve(srcRoot, "popup/index.html"), resolve(dest, "popup/index.html"));
        copyAsset(resolve(srcRoot, "popup/popup.css"), resolve(dest, "assets/popup.css"));
        if (existsSync(resolve(__dirname, "public/icon.svg"))) {
          copyAsset(resolve(__dirname, "public/icon.svg"), resolve(dest, "icon.svg"));
        }
        console.log("\u2713 Assets copied to dist/");
      },
    },
  ],
});
