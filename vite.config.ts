import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "fs";

function copyAsset(src: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function copyDir(srcDir: string, destDir: string) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    const src = resolve(srcDir, entry);
    const dest = resolve(destDir, entry);
    const stat = statSync(src);
    if (stat.isDirectory()) {
      copyDir(src, dest);
    } else {
      copyFileSync(src, dest);
    }
  }
}

function escapeNonAscii(content: string): string {
  return content.replace(/[\u0080-\uFFFF]/g, (char) => {
    const code = char.charCodeAt(0);
    return '\\u' + code.toString(16).padStart(4, '0');
  });
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

        // 复制 KaTeX 字体文件
        const katexFontsSrc = resolve(__dirname, "node_modules/katex/dist/fonts");
        if (existsSync(katexFontsSrc)) {
          copyDir(katexFontsSrc, resolve(dest, "fonts"));
        }

        if (existsSync(resolve(__dirname, "public/icon.svg"))) {
          copyAsset(resolve(__dirname, "public/icon.svg"), resolve(dest, "icon.svg"));
        }

        // 转义 content.js 中的非 ASCII 字符，避免 Chrome 报"不是 UTF-8 编码"
        const contentJsPath = resolve(dest, "content.js");
        if (existsSync(contentJsPath)) {
          const content = readFileSync(contentJsPath, "utf8");
          const escaped = escapeNonAscii(content);
          writeFileSync(contentJsPath, escaped, "ascii");
        }

        console.log("✓ Assets copied to dist/");
      },
    },
  ],
});
