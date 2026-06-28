// ImmerseReader — Content Script
import { extractContent, esc, shouldBlockByUrl, shouldBlockByDOM, runSiteAdapters, type ExtractedContent } from "./readability";

interface ActivateResult {
  active: boolean;
  blocked?: boolean;
  reason?: string;
}

if ((window as any).__IMMERSE_READER_INJECTED) {
  // already injected
} else {
  (window as any).__IMMERSE_READER_INJECTED = true;
  console.log("[ImmerseReader] Content script injected");

  // Clean up any shadow DOM expansion markers from previous sessions
  document.querySelectorAll(".ir-shadow-expand").forEach(el => el.remove());

  let active = false;
  let savedHead = "";
  let savedBody = "";
  let savedHtmlAttrs: { name: string; value: string }[] = [];
  let savedFootnotes: Map<string, string> | null = null;

  // Cache reader preferences (synced from storage at init time)
  let prefs: any = { theme: "light", fontSize: 18, fontFamily: "serif", margin: 720, lineHeight: 1.8 };

  // Read preferences from storage once at startup
  chrome.storage.sync.get(["irTheme","irFontSize","irFontFamily","irCustomBg","irCustomText","irCustomLink","irMargin","irLineHeight"], (p) => {
    if (p.irTheme)    prefs.theme = p.irTheme as string;
    else              chrome.storage.sync.set({ irTheme: "light" });
    if (p.irFontSize) prefs.fontSize = p.irFontSize as number;
    else              chrome.storage.sync.set({ irFontSize: 18 });
    if (p.irFontFamily) prefs.fontFamily = p.irFontFamily as string; else chrome.storage.sync.set({ irFontFamily: "serif" });
    if (p.irMargin)     prefs.margin = p.irMargin as number;       else chrome.storage.sync.set({ irMargin: 720 });
    if (p.irLineHeight) prefs.lineHeight = p.irLineHeight as number; else chrome.storage.sync.set({ irLineHeight: 1.8 });
    if (p.irCustomBg)   (prefs as any).customBg = p.irCustomBg as string;
    if (p.irCustomText) (prefs as any).customText = p.irCustomText as string;
    if (p.irCustomLink) (prefs as any).customLink = p.irCustomLink as string;
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case "toggleReader":
        if (active) { doDeactivate(); sendResponse({ active: false } as ActivateResult); }
        else        { sendResponse(doActivate(false)); }
        return false; // sync response — DOM is built synchronously now
      case "forceReader":
        // 逃生舱：跳过第 1/2 层启发式，直接跑第 3 层提取管线
        if (active) { sendResponse({ active: true } as ActivateResult); }
        else        { sendResponse(doActivate(true)); }
        return false;
      case "getState":
        sendResponse({ active });
        return false;
      case "updateCustomTheme":
        prefs.theme = "custom";
        prefs.customBg = message.bg as string;
        prefs.customText = message.text as string;
        prefs.customLink = message.link as string;
        if (active) {
          document.documentElement.setAttribute("data-ir-theme", "custom");
          applyCustomTheme(message.bg, message.text, message.link);
        }
        chrome.storage.sync.set({ irTheme: "custom", irCustomBg: message.bg as string, irCustomText: message.text as string, irCustomLink: message.link as string });
        sendResponse({ ok: true });
        return false;
      case "updateMargin":
        prefs.margin = message.margin as number;
        if (active) document.documentElement.style.setProperty("--ir-max-width", message.margin + "px");
        chrome.storage.sync.set({ irMargin: message.margin });
        sendResponse({ ok: true });
        return false;
      case "updateLineHeight":
        prefs.lineHeight = message.lineHeight as number;
        if (active) document.documentElement.style.setProperty("--ir-line-height", message.lineHeight);
        chrome.storage.sync.set({ irLineHeight: message.lineHeight });
        sendResponse({ ok: true });
        return false;

      case "updateTheme":
        prefs.theme = message.theme;
        if (active) {
          document.documentElement.setAttribute("data-ir-theme", message.theme);
          setThemeColors(message.theme);
        }
        chrome.storage.sync.set({ irTheme: message.theme });
        sendResponse({ ok: true });
        return false;
      case "updateFontSize":
        prefs.fontSize = message.size;
        if (active) {
          const s = Math.max(14, Math.min(32, message.size));
          document.documentElement.style.setProperty("--ir-font-size", s + "px");
        }
        chrome.storage.sync.set({ irFontSize: message.size });
        sendResponse({ ok: true });
        return false;
      case "updateFontFamily":
        prefs.fontFamily = message.family;
        if (active) document.documentElement.setAttribute("data-ir-font", message.family);
        chrome.storage.sync.set({ irFontFamily: message.family });
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  // ===== Reader CSS (inlined) =====
  const CSS = `/* ImmerseReader reader styles */
*,*::before,*::after{box-sizing:border-box}
html[data-ir-theme]{--ir-font-size:18px;--ir-line-height:1.8;--ir-max-width:720px;--ir-toolbar-height:48px}
html[data-ir-theme="light"]{--ir-bg:#faf9f6;--ir-text:#1a1a1a;--ir-heading:#0a0a0a;--ir-muted:#666;--ir-border:#e0ddd5;--ir-toolbar-bg:rgba(250,249,246,.95);--ir-link:#2563eb;--ir-code-bg:#f1f0ed;--ir-blockquote-border:#c4b998;--ir-blockquote-bg:#f3f0ea}
html[data-ir-theme="sepia"]{--ir-bg:#f4e8c1;--ir-text:#3b3226;--ir-heading:#2a2218;--ir-muted:#7a6b50;--ir-border:#d4c4a0;--ir-toolbar-bg:rgba(244,232,193,.95);--ir-link:#8b5e3c;--ir-code-bg:#e8dcc0;--ir-blockquote-border:#b8a888;--ir-blockquote-bg:#ede0c0}
html[data-ir-theme="dark"]{--ir-bg:#1a1a2e;--ir-text:#e0d6c8;--ir-heading:#f0ebe0;--ir-muted:#9a8f80;--ir-border:#2d2d44;--ir-toolbar-bg:rgba(26,26,46,.95);--ir-link:#7eb8f0;--ir-code-bg:#222240;--ir-blockquote-border:#4a4a6a;--ir-blockquote-bg:#22223a}
html[data-ir-theme="green"]{--ir-bg:#c7edcc;--ir-text:#1a3b2e;--ir-heading:#0a2a1e;--ir-muted:#3d6b50;--ir-border:#a8d4b0;--ir-toolbar-bg:rgba(199,237,204,.95);--ir-link:#1a6b40;--ir-code-bg:#b8e0c0;--ir-blockquote-border:#8ab898;--ir-blockquote-bg:#b8e0c0}
html[data-ir-font="serif"]{--ir-font:"Literata","Georgia","Noto Serif SC","Source Han Serif SC","STSong","SimSun",serif}
html[data-ir-font="sans"]{--ir-font:"Inter","Helvetica Neue","PingFang SC","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",sans-serif}
html[data-ir-font="mono"]{--ir-font:"JetBrains Mono","Fira Code","Consolas","monospace"}
html[data-ir-theme],html[data-ir-theme] body{margin:0;padding:0;background:var(--ir-bg);color:var(--ir-text);font-family:var(--ir-font);font-size:var(--ir-font-size);line-height:var(--ir-line-height);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.ir-toolbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:8px;height:var(--ir-toolbar-height);padding:0 16px;background:var(--ir-toolbar-bg);border-bottom:1px solid var(--ir-border);backdrop-filter:blur(8px)}
.ir-toolbar-title{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:.85em;color:var(--ir-muted)}
.ir-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ir-text);font-size:16px;cursor:pointer;transition:background .15s}
.ir-btn:hover{background:var(--ir-border);border-color:var(--ir-border)}
.ir-container{max-width:var(--ir-max-width);margin:0 auto;padding:40px 24px 80px;overflow-x:hidden}
.ir-header{margin-bottom:48px;padding-bottom:24px;border-bottom:1px solid var(--ir-border)}
.ir-headline{font-size:2em;line-height:1.4;font-weight:700;color:var(--ir-heading);margin:0 0 12px;letter-spacing:-.01em}
.ir-byline{color:var(--ir-muted);font-size:.9em;margin:0}
.ir-sitename{color:var(--ir-muted);font-size:.85em;text-transform:uppercase;letter-spacing:.05em;margin:0}
.ir-article{word-wrap:break-word;text-align:left;-webkit-hyphens:auto;hyphens:auto;font-variant-east-asian:normal;overflow-wrap:break-word;font-variant-east-asian:normal;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-break:loose;}
.ir-article p{margin:0 0 1.2em;text-indent:2em;hanging-punctuation:allow-end last;word-break:normal;line-break:auto;text-spacing:trim-start trim-end;overflow-wrap:break-word;}
.ir-article h1,.ir-article h2,.ir-article h3,.ir-article h4{color:var(--ir-heading);line-height:1.35;margin:1.8em 0 .6em;font-weight:600;text-indent:0}
.ir-article h1{font-size:1.6em}
.ir-article h2{font-size:1.4em}
.ir-article h3{font-size:1.2em}
.ir-article a{color:var(--ir-link);text-decoration:none;border-bottom:1px solid transparent}
.ir-article a:hover{border-bottom-color:var(--ir-link)}
.ir-article blockquote{margin:1.5em 0;padding:12px 24px;border-left:4px solid var(--ir-blockquote-border);background:var(--ir-blockquote-bg);border-radius:0 8px 8px 0;font-style:italic;color:var(--ir-muted);text-align:start;text-indent:0}
.ir-article pre{margin:1.2em 0;padding:16px 20px;background:var(--ir-code-bg);border-radius:8px;font-family:"JetBrains Mono","Fira Code","monospace";font-size:.85em;overflow-x:auto;line-height:1.6}
.ir-article code{font-family:"JetBrains Mono","Fira Code","monospace";font-size:.85em;background:var(--ir-code-bg);padding:2px 6px;border-radius:4px}
.ir-article pre code{background:none;padding:0}
.ir-article img,.ir-article video,.ir-article canvas,.ir-article embed,.ir-article object,.ir-article svg,.ir-article iframe{max-width:100%;height:auto;margin:1.5em auto;display:block;border-radius:8px;cursor:zoom-in}
.ir-article picture{display:block;margin:1.5em auto;text-align:center}
.ir-article picture img{margin:0}
/* 百度百科公式图：行内公式保持行内显示，块级公式居中独占一行 */
.ir-article img[data-ir-formula="inline"]{display:inline-block;vertical-align:middle;margin:0 .25em}
.ir-article img[data-ir-formula="block"]{display:block;margin:0 auto}
.ir-article ul,.ir-article ol{margin:1em 0;padding-left:1.5em}
.ir-article li{margin-bottom:.4em}
.ir-article hr{border:none;border-top:1px solid var(--ir-border);margin:2em 0}
.ir-article table{display:block;width:100%;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1.5em 0;font-size:.9em;-webkit-overflow-scrolling:touch}
.ir-article th,.ir-article td{padding:10px 14px;border:1px solid var(--ir-border);text-align:left}
.ir-article th{background:var(--ir-code-bg);font-weight:600;color:var(--ir-heading)}
.ir-progress-bar{position:fixed;top:0;left:0;right:0;height:3px;z-index:200;background:var(--ir-border);pointer-events:none}
.ir-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,var(--ir-link),#8b5e3c);transition:width .1s linear}
.ir-toc-btn{display:none;font-size:14px;padding:0 6px}
.ir-toc-btn.has-toc{display:inline-flex}
.ir-toc-sidebar{position:fixed;top:var(--ir-toolbar-height);right:-300px;bottom:0;width:260px;z-index:90;overflow-y:auto;padding:24px 16px 40px;background:var(--ir-bg);border-left:1px solid var(--ir-border);font-size:13px;line-height:1.5;transition:right .25s ease}
.ir-toc-sidebar.open{right:0}
.ir-toc-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--ir-muted);margin-bottom:12px;padding:0 8px}
.ir-toc-list{list-style:none;margin:0;padding:0}
.ir-toc-link{display:block;padding:3px 8px;border-radius:4px;color:var(--ir-muted);text-decoration:none;border-left:2px solid transparent;cursor:pointer;transition:all .15s}
.ir-toc-link:hover{color:var(--ir-text);background:var(--ir-code-bg)}
.ir-toc-link.active{color:var(--ir-link);border-left-color:var(--ir-link)}
.ir-toc-l1{padding-left:8px;font-weight:600;font-size:13px}
.ir-toc-l2{padding-left:24px;font-size:13px}
.ir-toc-l3{padding-left:40px;font-size:12px}
.ir-toc-l4{padding-left:56px;font-size:12px}
.ir-math{font-family:"Times New Roman","STIX Two Text","Latin Modern Math",serif;font-style:italic;padding:0 2px}
.ir-footer{text-align:center;color:var(--ir-muted);font-size:.85em;margin-top:60px;padding-top:24px;border-top:1px solid var(--ir-border)}
.ir-article figcaption{text-align:center;font-size:.85em;color:var(--ir-muted);margin:.6em 0 1.5em;font-style:italic}
.ir-article figure{margin:1.5em 0}
.ir-article figure img{margin:0 auto}
.ir-lb{display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);align-items:center;justify-content:center;cursor:zoom-out}
.ir-lb.open{display:flex}
.ir-lb img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 40px rgba(0,0,0,.5);cursor:default}
.ir-fn{display:none;position:absolute;z-index:500;max-width:300px;background:var(--ir-bg);border:1px solid var(--ir-border);border-radius:8px;padding:10px 14px;font-size:.85em;line-height:1.5;color:var(--ir-text);box-shadow:0 4px 16px rgba(0,0,0,.15);text-align:left;text-indent:0;cursor:default}
.ir-fn.open{display:block}
@media print{.ir-toolbar{display:none}.ir-container{padding:0;max-width:none}}
@media(max-width:768px){.ir-container{padding:24px 16px 60px}.ir-headline{font-size:1.5em}}
@media(max-width:480px){.ir-container{padding:16px 12px 40px}.ir-headline{font-size:1.3em}}`;

  // ===== Google Fonts — loaded asynchronously, never blocks rendering =====
  const GOOGLE_FONTS_URL =
    "https://fonts.googleapis.com/css2?" +
    "family=Literata:opsz,wght@7..72,400;7..72,600;7..72,700&" +
    "family=Noto+Serif+SC:wght@400;600;700&" +
    "family=Noto+Sans+SC:wght@400;600;700&" +
    "family=JetBrains+Mono:wght@400;600&" +
    "display=swap";

  function loadGoogleFontsAsync() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = GOOGLE_FONTS_URL;
    link.media = "print";         // non-render-blocking
    link.onload = () => { link.media = "all"; };
    document.head.appendChild(link);
  }

  // 收集页面中的脚注定义（id 含 fn/footnote/note/ref/cite + 数字）
  function collectFootnotes(doc: Document): Map<string, string> {
    const defs = new Map<string, string>();
    try {
      doc.querySelectorAll("[id]").forEach(el => {
        const id = el.id;
        if (!id) return;
        const lower = id.toLowerCase();
        if (/\b(fn|footnote|note|ref|cite)\b.*\d/.test(lower) && lower.length < 40) {
          const text = (el.textContent || "").trim();
          if (text.length > 0) defs.set("#" + id, text);
        }
      });
    } catch (err) {
      console.warn("[ImmerseReader] 脚注收集失败", err);
    }
    return defs;
  }

function buildReaderView(content: ExtractedContent) {
    if (!content || Array.isArray(content) || typeof content.content !== 'string') {
      if (content && typeof content.textContent === 'string' && content.textContent.length > 0) {
        // Fallback: reconstruct HTML from textContent if content field is missing
        content.content = '<p>' + content.textContent.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
      } else {
        console.warn("[ImmerseReader] Cannot build reader view: no content available");
        return;
      }
    }
    const theme = prefs.theme;
    const fontSize = prefs.fontSize;
    const fontFamily = prefs.fontFamily;
    const margin = (prefs as any).margin || 720;
    const lineHeight = (prefs as any).lineHeight || 1.8;
    const customBg = (prefs as any).customBg;
    const customText = (prefs as any).customText;
    const customLink = (prefs as any).customLink;

    const rt = Math.max(1, Math.ceil(content.length / 500));
    const t = esc(content.title);
    const b = content.byline   ? '<p class="ir-byline">'    + esc(content.byline)   + '</p>' : "";
    const s = content.siteName ? '<p class="ir-sitename">'  + esc(content.siteName) + '</p>' : "";

    document.documentElement.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = CSS;

    const head = document.createElement("head");
    head.innerHTML =
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1.0">' +
      '<title>' + t + ' — ImmerseReader</title>';
    head.appendChild(style);

    // Preserve math formula CSS from original page (KaTeX, MathJax, etc.)
    if (savedHead) {
      const ms = savedHead.match(/<style[^>]*>[\s\S]*?(?:\.katex|\.MathJax)[\s\S]*?<\/style>/gi);
      if (ms) ms.forEach(function(css) {
        var s = document.createElement("style");
        s.textContent = css.replace(/<\/?style[^>]*>/g, "");
        head.appendChild(s);
      });
      var lk = savedHead.match(/<link[^>]*href="[^"]*(?:katex|mathjax)[^"]*"[^>]*>/gi);
      if (lk) lk.forEach(function(h) {
        var hr = h.match(/href="([^"]+)"/);
        if (hr) {
          var l = document.createElement("link");
          l.rel = "stylesheet";
          l.href = hr[1];
          head.appendChild(l);
        }
      });
   }

    // Also inject MathJax script from original page (renders raw LaTeX)
    if (savedHead) {
      var mjScripts = savedHead.match(/<script[^>]*src="[^"]*mathjax[^"]*"[^>]*>[\s\S]*?<\/script>/gi);
      if (mjScripts) mjScripts.forEach(function(h) {
        var srcMatch = h.match(/src="([^"]+)"/);
        if (srcMatch) {
          var s = document.createElement("script");
          s.src = srcMatch[1];
          s.async = true;
          head.appendChild(s);
        }
      });
    }

    const body = document.createElement("body");
    body.innerHTML =
      '<div class="ir-progress-bar"><div class="ir-progress-fill" id="ir-progress-fill"></div></div>' +
      '<div class="ir-toolbar" id="ir-toolbar">' +
      '  <button class="ir-btn ir-btn-close" id="ir-back" title="返回原文">&times;</button>' +
      '  <span class="ir-toolbar-title">' + t + '</span>' +
      '  <div class="ir-toolbar-right">' +
      '    <button class="ir-btn" id="ir-summarize" title="AI 摘要（Phase 2）">&#128203;</button>' +
      '    <button class="ir-btn ir-toc-btn" id="ir-toc-btn" title="目录">&#9776;</button>' +
      '    <button class="ir-btn" id="ir-fullscreen" title="全屏阅读">&#9974;</button>' +
      '  </div></div>' +
      '<main class="ir-container">' +
      '  <header class="ir-header">' +
      '    <h1 class="ir-headline">' + t + '</h1>' + b + s +
      '  </header>' +
      '  <article class="ir-article">' + content.content + '</article>' +
      '  <footer class="ir-footer"><p>&mdash; 约 ' + rt + ' 分钟阅读 &mdash;</p></footer>' +
      '</main>' +
      '<nav class="ir-toc-sidebar" id="ir-toc-sidebar">' +
      '  <div class="ir-toc-title">&#30446;&#24405;</div>' +
      '  <div class="ir-toc-list" id="ir-toc-list"></div>' +
      '</nav>';

    const html = document.createElement("html");
    html.setAttribute("data-ir-theme", theme);
    html.setAttribute("data-ir-font", fontFamily);
    html.style.setProperty("--ir-font-size", fontSize + "px");
    html.style.setProperty("--ir-max-width", margin + "px");
    html.style.setProperty("--ir-line-height", String(lineHeight));
    if (theme === "custom" && customBg && customText && customLink) {
      applyCustomTheme(customBg, customText, customLink);
    }

    html.appendChild(head);
    html.appendChild(body);

    document.replaceChild(html, document.documentElement);

    // 清理原页面代码块自带的行号和语言标签（所有提取路径的兜底）
    // sanitizeHtml 只作用于 Readability 路径，fallback/density 路径需在此清理
    try {
      const article = document.querySelector(".ir-article");
      if (article) {
        // 1. 已知 class 的行号元素
        article.querySelectorAll(
          '.hljs-ln-numbers,.hljs-ln-n,.line-number,.line-num,.line-numbers,.ln-num,.ln-number,' +
          '[data-line-number],.code-line-number,.td-line-number,.blob-num'
        ).forEach(el => el.remove());
        // 2. pre 内的 ol/ul 纯数字行号
        article.querySelectorAll("pre > ol, pre > ul").forEach(list => {
          list.querySelectorAll("li").forEach(li => {
            if (/^\d+$/.test((li.textContent || "").trim())) li.remove();
          });
        });
        // 3. pre table 的纯数字首列
        article.querySelectorAll("pre table").forEach(table => {
          table.querySelectorAll("tr > td:first-child, tr > th:first-child").forEach(cell => {
            if (/^\d+$/.test((cell.textContent || "").trim())) cell.remove();
          });
        });
        // 4. 已知 class 的语言标签和工具栏
        article.querySelectorAll(
          '.code-language,.code-lang,.lang-label,.language-label,' +
          '.hljs-lang,.code-title,.code-toolbar,.toolbar'
        ).forEach(el => el.remove());
        // 5. pre 内的纯数字行号 span
        article.querySelectorAll("pre").forEach(pre => {
          pre.querySelectorAll('span[class*="number"], span[class*="line-num"], span[class*="ln-num"]').forEach(span => {
            if (/^\d+$/.test((span.textContent || "").trim())) span.remove();
          });
        });
        // 6. pre 后面紧邻的 ul/ol：如果所有 li 都是纯数字，整条移除（CSDN 行号）
        article.querySelectorAll("pre").forEach(pre => {
          let sibling = pre.nextElementSibling;
          while (sibling && (sibling.tagName === "UL" || sibling.tagName === "OL")) {
            const items = sibling.querySelectorAll("li");
            let allNumbers = items.length > 0;
            let prevNum = 0;
            for (const li of items) {
              const t = (li.textContent || "").trim();
              if (!/^\d+$/.test(t)) { allNumbers = false; break; }
              const n = parseInt(t, 10);
              if (n <= prevNum) { allNumbers = false; break; }
              prevNum = n;
            }
            const next = sibling.nextElementSibling;
            if (allNumbers) sibling.remove();
            sibling = next;
          }
        });
        // 7. pre 后面紧邻的短文本：如果看起来像语言名（<15字符，全字母数字），移除
        const LANG_RE = /^(xml|html|css|javascript|js|typescript|ts|java|python|bash|shell|sql|json|yaml|yml|go|rust|c|c\+\+|cpp|c#|cs|ruby|php|swift|kotlin|dart|vue|react|markdown|md|plain|text|ini|conf|nginx|dockerfile|makefile|protobuf|gradle|maven|pom)$/i;
        article.querySelectorAll("pre").forEach(pre => {
          let sibling = pre.nextElementSibling;
          let count = 0;
          while (sibling && count < 3) {
            const tag = sibling.tagName.toLowerCase();
            // 只检查行内/短文本容器
            if (["p", "span", "div", "em", "strong", "small"].includes(tag)) {
              const text = (sibling.textContent || "").trim();
              if (text.length > 0 && text.length < 15 && LANG_RE.test(text)) {
                const next = sibling.nextElementSibling;
                sibling.remove();
                sibling = next;
                count++;
                continue;
              }
            }
            // 遇到块级元素或非语言文本就停
            if (["pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "hr"].includes(tag)) break;
            break;
          }
        });
      }
    } catch (err) {
      console.warn("[ImmerseReader] 代码块装饰清理失败，跳过", err);
    }

    // Load Google Fonts async — never blocks rendering
    loadGoogleFontsAsync();

    // Bind toolbar buttons
    document.getElementById("ir-back")?.addEventListener("click", doDeactivate);
    document.getElementById("ir-fullscreen")?.addEventListener("click", () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    });
    document.getElementById("ir-summarize")?.addEventListener("click", () => {
      showToast("AI 摘要功能将在 Phase 2 中实现");
    });

    // ==== Lightbox for images ====
    (function initLightbox() {
      // Lazily create lightbox DOM once
      let lb: HTMLElement | null = null;
      let lbImg: HTMLImageElement | null = null;

      function openLightbox(src: string) {
        if (!lb) {
          lb = document.createElement("div");
          lb.className = "ir-lb";
          lb.setAttribute("role", "dialog");
          lb.setAttribute("aria-label", "图片放大查看");
          lbImg = document.createElement("img");
          lb.appendChild(lbImg);
          lb.addEventListener("click", (e) => {
            if (e.target === lb) closeLightbox();
          });
          document.body.appendChild(lb);
        }
        if (lbImg) {
          lbImg.src = src;
          lbImg.alt = "";
        }
        lb.classList.add("open");
      }

      function closeLightbox() {
        lb?.classList.remove("open");
        if (lbImg) lbImg.src = "";
      }

      // Esc to close
      function onKeyDown(e: KeyboardEvent) {
        if (e.key === "Escape") closeLightbox();
      }
      document.addEventListener("keydown", onKeyDown);

      // 禁用图片的 <a> 包裹点击行为，阻止原网站跳转逻辑
      document.querySelectorAll(".ir-article img").forEach((img) => {
        const parentAnchor = img.closest("a");
        if (parentAnchor) {
          parentAnchor.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
        }
        // 图片点击走 lightbox
        img.addEventListener("click", (e) => {
          e.stopPropagation();
          const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src;
          if (src) openLightbox(src);
        });
      });

      // 点击 lightbox 中的图片也可以关闭
      if (lbImg) {
        lbImg.addEventListener("click", (e) => {
          e.stopPropagation();
          closeLightbox();
        });
      }

      // Cleanup on deactivate
      const origDeactivate = doDeactivate;
      (window as any).__ir_deactivate = origDeactivate;
    })();

    // ==== Footnote hover tooltip ====
    (function initFootnotes() {
      const article = document.querySelector(".ir-article");
      if (!article) return;

      // 优先用提前从原页面收集的脚注定义（Readability 可能过滤底部参考文献）
      const defs = savedFootnotes || new Map<string, string>();

      // 如果原页面没收集到，尝试从阅读视图中收集（fallback）
      if (defs.size === 0) {
        article.querySelectorAll("[id]").forEach(el => {
          const id = el.id;
          if (!id) return;
          const lower = id.toLowerCase();
          if (/\b(fn|footnote|note|ref|cite)\b.*\d/.test(lower) && lower.length < 40) {
            const text = (el.textContent || "").trim();
            if (text.length > 0) defs.set("#" + id, text);
          }
        });
      }

      if (defs.size === 0) return;

      // 创建气泡 DOM（懒创建）
      let tooltip: HTMLElement | null = null;
      function getTooltip(): HTMLElement {
        if (!tooltip) {
          tooltip = document.createElement("div");
          tooltip.className = "ir-fn";
          document.body.appendChild(tooltip);
        }
        return tooltip;
      }

      function showFootnote(ref: string) {
        const content = defs.get(ref);
        if (!content) return;
        const el = document.querySelector(ref);
        if (!el) return;
        const tt = getTooltip();
        tt.textContent = content;
        tt.classList.add("open");
        // 定位：基于引用元素
        const rect = el.getBoundingClientRect();
        const articleRect = article.getBoundingClientRect();
        const scrollTop = window.scrollY;
        let top = scrollTop + rect.bottom + 6;
        let left = scrollTop + rect.left;
        // 右侧溢出检测
        if (left + 300 > articleRect.right + window.scrollX) {
          left = scrollTop + rect.right - 310;
        }
        tt.style.top = top + "px";
        tt.style.left = left + "px";
      }

      function hideFootnote() {
        tooltip?.classList.remove("open");
      }

      // 绑定所有 sup a[href^="#"] 点击
      article.querySelectorAll("sup a[href^='#']").forEach(a => {
        const href = (a as HTMLAnchorElement).getAttribute("href") || "";
        const hash = href.startsWith("#") ? href : "#" + href.split("#").pop();
        if (defs.has(hash)) {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (tooltip?.classList.contains("open")) {
              hideFootnote();
            } else {
              showFootnote(hash);
            }
          });
        }
      });

      // 点击气泡外或 Esc 关闭
      document.addEventListener("click", (e) => {
        const target = e.target as Node;
        if (tooltip?.contains(target)) return;
        if (tooltip?.classList.contains("open")) hideFootnote();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideFootnote();
      });
    })();

    // ==== Build TOC sidebar ====
    const tocList = document.getElementById("ir-toc-list");
    const tocSidebar = document.getElementById("ir-toc-sidebar");
    const articleEl = document.querySelector(".ir-article");
    if (tocList && articleEl) {
      const headings = articleEl.querySelectorAll("h1, h2, h3, h4");
      if (headings.length > 3) {
        headings.forEach((h, i) => {
          const id = "ir-sec-" + i;
          h.id = id;
          const level = parseInt(h.tagName[1]);
          const link = document.createElement("a");
          link.className = "ir-toc-link ir-toc-l" + level;
          link.textContent = h.textContent || "";
          link.href = "#" + id;
          link.addEventListener("click", (e) => {
            e.preventDefault();
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
          tocList.appendChild(link);
        });
        const tocLinks = tocList.querySelectorAll(".ir-toc-link");
        const observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              tocLinks.forEach(l => l.classList.remove("active"));
              tocList.querySelector('[href="#' + entry.target.id + '"]')?.classList.add("active");
            }
          });
        }, { rootMargin: "-60px 0px -50% 0px" });
       headings.forEach(h => observer.observe(h));
        document.getElementById("ir-toc-btn")?.classList.add("has-toc");
        document.getElementById("ir-toc-btn")?.addEventListener("click", () => {
          if (tocSidebar) {
            const showing = tocSidebar.style.right === "0px" || tocSidebar.classList.contains("open");
            tocSidebar.style.right = showing ? "-300px" : "0px";
            tocSidebar.classList.toggle("open");
          }
        });
      }
    }

    // ==== Progress bar scroll tracking ====
    const progressFill = document.getElementById("ir-progress-fill");
    if (progressFill) {
      document.addEventListener("scroll", () => {
        const st = document.documentElement.scrollTop || document.body.scrollTop;
        const sh = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        progressFill.style.width = (sh > 0 ? (st / sh * 100) : 0) + "%";
      }, { passive: true });
    }

    active = true;
    // Trigger math rendering (MathJax/KaTeX) — runs in page context
    var _m = document.createElement("script");
    _m.textContent = "!function(){var e=0,t=setInterval(function(){if(++e>20)return clearInterval(t);var n=!1;window.MathJax&&(MathJax.typesetPromise?(MathJax.typesetPromise(),n=!0):MathJax.Hub&&(MathJax.Hub.Queue([\"Typeset\",MathJax.Hub]),n=!0)),window.renderMathInElement&&(renderMathInElement(document.body),n=!0),n&&clearInterval(t)},600)}();";
    document.body.appendChild(_m);
    // KaTeX manual render for Zhihu-style dynamic math
    var _k = document.createElement("script");
    _k.textContent = "!function(){var e=0,t=setInterval(function(){if(++e>20||!window.katex)return clearInterval(t);document.querySelectorAll(\".zh-math\").forEach(function(r){var n=(r.textContent||\"\").slice(2,-2);if(n){var h=katex.renderToString(n,{throwOnError:!1});var s=document.createElement(\"span\");s.innerHTML=h;if(r.parentNode)r.parentNode.replaceChild(s,r)}});clearInterval(t)},600)}();"

    document.body.appendChild(_k);
    // Hide .zh-math containers via CSS (display:contents makes container vanish but children stay)
    var _kcss = document.createElement("style");
    _kcss.textContent = ".zh-math{display:contents!important;background:transparent!important;border:none!important;padding:0!important;margin:0!important;font:inherit!important;color:inherit!important}";
    document.head.appendChild(_kcss);
    chrome.storage.local.set({ irActive: true });
  }

  // ===== SPA 观察器：MutationObserver 替代固定超时 =====
  function applyCustomTheme(bg: string, text: string, link: string) {
    const d = document.documentElement;
    d.style.setProperty("--ir-bg", bg);
    d.style.setProperty("--ir-text", text);
    d.style.setProperty("--ir-heading", text);
    d.style.setProperty("--ir-muted", adjustColor(text, -50));
    d.style.setProperty("--ir-border", adjustColor(text, 200));
    d.style.setProperty("--ir-toolbar-bg", hexToRgba(bg, 0.95));
    d.style.setProperty("--ir-link", link);
    d.style.setProperty("--ir-code-bg", adjustColor(bg, -10));
    d.style.setProperty("--ir-blockquote-border", link);
    d.style.setProperty("--ir-blockquote-bg", adjustColor(bg, -3));
  }
  function adjustColor(h: string, a: number): string {
    const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(h);
    if (!m) return h;
    const r = Math.max(0, Math.min(255, parseInt(m[1],16)+a));
    const g = Math.max(0, Math.min(255, parseInt(m[2],16)+a));
    const b = Math.max(0, Math.min(255, parseInt(m[3],16)+a));
    return "#"+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
  }
  function hexToRgba(h: string, a: number): string {
    const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(h);
    if (!m) return h;
    return "rgba("+parseInt(m[1],16)+","+parseInt(m[2],16)+","+parseInt(m[3],16)+","+a+")";
  }

  function setThemeColors(theme: string) {
    var P = {light: ["#faf9f6","#1a1a1a","#2563eb"], sepia: ["#f4e8c1","#3b3226","#8b5e3c"], dark: ["#1a1a2e","#e0d6c8","#7eb8f0"], green: ["#c7edcc","#1a3b2e","#1a6b40"]};
    var p = P[theme];
    if (p) {
      const d = document.documentElement;
      d.style.setProperty("--ir-bg", p[0]); d.style.setProperty("--ir-text", p[1]); d.style.setProperty("--ir-heading", p[1]);
      d.style.setProperty("--ir-muted", adjustColor(p[1], -50)); d.style.setProperty("--ir-border", adjustColor(p[1], 200));
      d.style.setProperty("--ir-toolbar-bg", hexToRgba(p[0], 0.95)); d.style.setProperty("--ir-link", p[2]);
      d.style.setProperty("--ir-code-bg", adjustColor(p[0], -10)); d.style.setProperty("--ir-blockquote-border", p[2]);
      d.style.setProperty("--ir-blockquote-bg", adjustColor(p[0], -3));
    }
  }

  let spaObserver: MutationObserver | null = null;
  let spaTimer: ReturnType<typeof setTimeout> | undefined;
  let spaMaxTimeout: ReturnType<typeof setTimeout> | undefined;

  function stopSpaObserver() {
    if (spaObserver) { spaObserver.disconnect(); spaObserver = null; }
    if (spaTimer !== undefined) { clearTimeout(spaTimer); spaTimer = undefined; }
    if (spaMaxTimeout !== undefined) { clearTimeout(spaMaxTimeout); spaMaxTimeout = undefined; }
  }

  function trySpaExtract() {
    if (!active) { stopSpaObserver(); return; }
    const content = extractContent();
    if (content) {
      console.log("[ImmerseReader] SPA observer found content, length:", content.length);
      stopSpaObserver();
      buildReaderView(content);
    }
  }

  function startSpaObserver() {
    stopSpaObserver();
    console.log("[ImmerseReader] Starting SPA observer...");

    spaMaxTimeout = setTimeout(() => {
      console.log("[ImmerseReader] SPA observer max timeout");
      stopSpaObserver();
      if (active) {
        active = false;
        chrome.storage.local.set({ irActive: false });
        showToast("无法提取文章内容：页面暂不兼容阅读模式");
      }
    }, 8000);

    spaTimer = setTimeout(trySpaExtract, 1500);

    if (document.body) {
      spaObserver = new MutationObserver(() => {
        if (spaTimer !== undefined) clearTimeout(spaTimer);
        spaTimer = setTimeout(trySpaExtract, 800);
      });
      spaObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function doActivate(force: boolean): ActivateResult {
    console.log("[ImmerseReader] doActivate called, active=", active, "force=", force);
    if (active) return { active: true };

    // 业务边界：仅非 force 模式下跑第 1/2 层启发式
    if (!force) {
      const urlBlock = shouldBlockByUrl(location.href);
      if (urlBlock) {
        console.log("[ImmerseReader] blocked by URL:", urlBlock.reason, "| url:", location.href);
        showToast("此页面不适合阅读模式：" + urlBlock.reason);
        return { active: false, blocked: true, reason: urlBlock.reason };
      }
      console.log("[ImmerseReader] URL layer passed, checking DOM...");
      const domBlock = shouldBlockByDOM(document);
      if (domBlock) {
        console.log("[ImmerseReader] blocked by DOM:", domBlock.reason);
        showToast("此页面不适合阅读模式：" + domBlock.reason);
        return { active: false, blocked: true, reason: domBlock.reason };
      }
      console.log("[ImmerseReader] DOM layer passed, proceeding to extract");
    }

    // Save original state
    savedHead = document.head.innerHTML;
    savedBody = document.body.innerHTML;
    savedHtmlAttrs = [];
    for (let i = 0; i < document.documentElement.attributes.length; i++) {
      const a = document.documentElement.attributes[i];
      savedHtmlAttrs.push({ name: a.name, value: a.value });
    }

    // 提前收集原页面脚注定义（Readability 可能会过滤底部参考文献）
    savedFootnotes = collectFootnotes(document);

    // 站点专属预处理（clone 前阶段）
    runSiteAdapters(document, "BEFORE_CLONE");

    const content = extractContent();

    if (content) {
      console.log("[ImmerseReader] Content extracted, length:", content.length);
      buildReaderView(content);
      return { active: true };
    }

    // SPA 页面异步内容尚未加载
    // MutationObserver 等待 DOM 稳定后自动再试
    active = true;
    chrome.storage.local.set({ irActive: true });
    startSpaObserver();
    return { active: true };
  }

 function doDeactivate() {
   console.log("[ImmerseReader] doDeactivate");
    stopSpaObserver();
   if (!active) return;
   active = false;
    chrome.storage.local.set({ irActive: false });

    // buildReaderView 清空了文档，杀死了所有 JS 上下文和 Web Components 实例。
    // DOM 恢复（innerHTML）会同步触发组件的 connectedCallback，
    // 而数据依赖已不存在，导致组件初始化失败并可能阻塞主线程。
    // 唯一可靠的方案：直接刷新页面，让浏览器重新加载完整页面。
    if (location.href.startsWith("http")) {
      location.reload();
    }
  }

 function showToast(msg: string) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:12px 24px;border-radius:8px;font-family:system-ui;font-size:14px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:90vw;text-align:center;line-height:1.4";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
}
