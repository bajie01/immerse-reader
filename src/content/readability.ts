import { Readability } from "@mozilla/readability";

export interface ExtractedContent {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  length: number;
}

// ====================================================================
// 业务边界判定 —— 在进入提取管线前主动阻塞不适合阅读的页面
// ====================================================================

export interface BlockReason {
  layer: "url" | "dom";
  reason: string;
}

// 第 1 层：URL 启发式（毫秒级，不读 DOM）
export function shouldBlockByUrl(url: string): BlockReason | null {
  let path: string;
  let query: string;
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    query = u.search.toLowerCase();
  } catch {
    return null;
  }

  // 根路径 / 首页
  if (path === "/" || path === "/home" || path === "/index" || path === "/index.html" || path === "/index.htm") {
    return { layer: "url", reason: "检测为站点首页" };
  }

  // 认证/账号页
  if (/\/(login|signup|register|signin|logout|account|settings|dashboard)(\/|$)/.test(path)) {
    return { layer: "url", reason: "检测为账号/设置页面" };
  }

  // 搜索/列表/标签聚合页
  if (/\/(search|tag|tags|category|categories|archive)(\/|$)/.test(path)) {
    return { layer: "url", reason: "检测为搜索/列表/分类页" };
  }

  // query 里含明显的列表/搜索参数
  if (/[?&](list|search|category|tag|tags|page|p)=/.test(query)) {
    return { layer: "url", reason: "检测为列表/搜索结果页" };
  }

  // 非文档类资源
  if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|rar|tar|gz|mp4|mp3|avi|mov|exe|dmg|apk)(\?|$)/.test(path)) {
    return { layer: "url", reason: "检测为非文档资源" };
  }

  return null;
}

// 第 2 层：DOM 启发式（百毫秒级，主动判定）
export function shouldBlockByDOM(doc: Document): BlockReason | null {
  const body = doc.body;
  if (!body) return null;

  const bodyText = (body.textContent || "").replace(/\s+/g, " ").trim();
  // 空页面或极短页面不判阻塞，留给第 3 层处理
  if (bodyText.length < 200) return null;

  // 判定 A: 链接文字占比过高 → 导航/列表页
  const links = Array.from(doc.querySelectorAll("a"));
  let linkTextLen = 0;
  for (const a of links) {
    linkTextLen += (a.textContent || "").replace(/\s+/g, " ").trim().length;
  }
  if (bodyText.length > 0 && linkTextLen / bodyText.length > 0.5) {
    return { layer: "dom", reason: "检测为列表/导航页（链接密度过高）" };
  }

  // 收集候选正文段落（与 bruteForceExtract 口径一致：长度 > 30 且非广告/导航）
  const paragraphs = Array.from(doc.querySelectorAll("p")).filter((p) => {
    const text = (p.textContent || "").trim();
    return text.length > 30 && !isAdOrNav(p);
  });

  // 也统计 <div> 里的长文本块：有些站点（如百家号）用 div 而非 p 包裹正文，
  // 只看 <p> 会漏判。收集直接含长文本的 div（排除子 div 重复计数）。
  const longDivs = Array.from(doc.querySelectorAll("div")).filter((d) => {
    if (isAdOrNav(d)) return false;
    const directText = Array.from(d.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || "")
      .join("")
      .trim();
    return directText.length > 100;
  });

  // 安全阀：页面正文总量足够大时，几乎不可能是卡片流，直接放行。
  // bodyText 已 > 200（开头已判断），这里用更阈值判定。
  const longParagraphs = paragraphs.filter((p) => (p.textContent || "").trim().length > 200);
  const totalLongBlocks = longParagraphs.length + longDivs.length;

  // 判定 B: 无 <article> 且长段落（>200 字）不足 3 个 且段落数 ≥ 5 → 卡片流
  const hasArticle = !!doc.querySelector("article, [role='article'], [role='main'], main");
  if (!hasArticle && totalLongBlocks < 3 && paragraphs.length >= 5 && bodyText.length < 1500) {
    return { layer: "dom", reason: "检测为卡片流页面（缺少连续长文段落）" };
  }

  // 判定 C: 段落普遍过短（中位数 < 40 字）且段落数较多 → 卡片流
  if (paragraphs.length >= 8 && paragraphs.length < 500) {
    const lens = paragraphs.map((p) => (p.textContent || "").trim().length).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)];
    if (median < 40 && totalLongBlocks < 2 && bodyText.length < 1500) {
      return { layer: "dom", reason: "检测为卡片流页面（段落普遍过短）" };
    }
  }

  // 判定 D: iframe 主导 → 应用页
  const iframes = Array.from(doc.querySelectorAll("iframe"));
  if (iframes.length >= 1 && totalLongBlocks < 2) {
    // 估算 iframe 总面积占视口比例
    const vpArea = window.innerWidth * window.innerHeight;
    let iframeArea = 0;
    for (const f of iframes) {
      const r = f.getBoundingClientRect();
      iframeArea += r.width * r.height;
    }
    if (vpArea > 0 && iframeArea / vpArea > 0.5) {
      return { layer: "dom", reason: "检测为应用页面（iframe 占主区域）" };
    }
  }

  return null;
}

// ====================================================================
// 统一提取管道 —— 纯通用，不依赖任何 DOM 结构假设

// ====================================================================
// 站点专属预处理 —— 在 Readability 提取前修复特定站点的 DOM 结构问题
// ====================================================================

export type AdapterPhase = "BEFORE_CLONE" | "AFTER_CLONE";

interface SiteAdapter {
  name: string;
  match: (host: string) => boolean;
  phase: AdapterPhase;
  run: (doc: Document) => void;
}

const siteAdapters: SiteAdapter[] = [
  {
    name: "mdn-shadow-dom",
    match: (h) => h.includes("developer.mozilla.org"),
    phase: "BEFORE_CLONE",
    run: expandMdnCodeExamples,
  },
  {
    name: "baidu-baike-formula",
    match: (h) => h.includes("baike.baidu.com"),
    phase: "AFTER_CLONE",
    run: flattenBaiduFormulaSections,
  },
  {
    name: "mediawiki-math",
    match: (h) => MEDIAWIKI_HOSTS.some((domain) => h.includes(domain)),
    phase: "AFTER_CLONE",
    run: flattenMediaWikiMathSections,
  },
];

const MEDIAWIKI_HOSTS = [
  "wikipedia.org",
  "wikimedia.org",
  "wikiwand.com",
  "wiktionary.org",
  "wikidata.org",
  "wikisource.org",
  "wikibooks.org",
  "wikiquote.org",
  "wikiversity.org",
  "wikivoyage.org",
  "wikinews.org",
];

export function runSiteAdapters(doc: Document, phase: AdapterPhase): void {
  const host = doc.defaultView?.location?.hostname || doc.location?.hostname || document.location?.hostname || "";
  for (const adapter of siteAdapters) {
    if (adapter.phase !== phase) continue;
    if (!adapter.match(host)) continue;
    try {
      adapter.run(doc);
    } catch (e) {
      console.warn(`[ImmerseReader] site adapter ${adapter.name} failed:`, e);
    }
  }
}

// MDN 代码示例预处理：展开 <mdn-code-example> 自定义元素的 Shadow DOM，提取其中的 <pre><code>
function expandMdnCodeExamples(doc: Document): void {
  const codeExamples = doc.querySelectorAll("mdn-code-example");
  for (let i = codeExamples.length - 1; i >= 0; i--) {
    try {
      const el = codeExamples[i];
      const shadow = (el as any).shadowRoot as ShadowRoot | null;
      if (!shadow) continue;

      const pre = shadow.querySelector("pre");
      if (!pre) continue;

      const codeEl = pre.querySelector("code");
      const codeInner = codeEl ? codeEl.innerHTML : pre.innerHTML;

      const replacementHTML = `<pre><code>${codeInner}</code></pre>`;
      el.outerHTML = replacementHTML;
    } catch {}
  }
}

// 百度百科公式预处理：将行内公式 section 展平为裸 img，避免 Readability 拆散行内结构
function flattenBaiduFormulaSections(doc: Document): void {
  const sections = doc.querySelectorAll("section");
  for (const section of Array.from(sections)) {
    const img = section.querySelector("img");
    if (!img) continue;

    // 判断是否为行内公式：内部 div 的 display 值为 inline
    const innerDiv = section.querySelector("div");
    const isInline = innerDiv && innerDiv.style && innerDiv.style.display === "inline";

    // 创建新的 img 替代 section
    const newImg = doc.createElement("img");
    // 复制 img 的所有属性
    for (const attr of Array.from(img.attributes)) {
      newImg.setAttribute(attr.name, attr.value);
    }
    // 标记公式类型
    newImg.setAttribute("data-ir-formula", isInline ? "inline" : "block");

    // 保留 vertical-align 等关键样式到 style 属性
    if (img.style.verticalAlign) {
      newImg.style.verticalAlign = img.style.verticalAlign;
    }
    if (img.style.width) {
      newImg.style.width = img.style.width;
    }
    if (img.style.height) {
      newImg.style.height = img.style.height;
    }

    // 替换 section 为新 img
    section.parentNode?.replaceChild(newImg, section);
  }
}

// MediaWiki 数学公式预处理：提取 span 内的 fallback img，避免 Readability 因 math 标签拆散行内结构
// 适用站点：wikipedia.org / wikimedia.org / wikiwand.com / wiktionary.org / wikidata.org 等
function flattenMediaWikiMathSections(doc: Document): void {
  const mathImgs = doc.querySelectorAll(
    "img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display"
  );
  for (const img of Array.from(mathImgs)) {
    const parentSpan = img.closest("span.mwe-math-element");
    if (!parentSpan) continue;

    const isInline = img.classList.contains("mwe-math-fallback-image-inline");

    const newImg = doc.createElement("img");
    for (const attr of Array.from(img.attributes)) {
      newImg.setAttribute(attr.name, attr.value);
    }
    newImg.setAttribute("data-ir-formula", isInline ? "inline" : "block");

    if (img.style.verticalAlign) newImg.style.verticalAlign = img.style.verticalAlign;
    if (img.style.width) newImg.style.width = img.style.width;
    if (img.style.height) newImg.style.height = img.style.height;

    parentSpan.parentNode?.replaceChild(newImg, parentSpan);
  }
}

export function extractContent(): ExtractedContent | null {
  // 策略 1: Readability 标准提取
  const clone = document.cloneNode(true) as Document;
  // 站点专属预处理（clone 后阶段）
  runSiteAdapters(clone, "AFTER_CLONE");
  const article = new Readability(clone).parse();
  if (article && article.content && article.length > 100) {
    const r = makeResult(article);
    // 质量门：纯文本不足 300 字符的不算有效提取
    // （防止 MSN 这类页面返回 165 字元数据碎片）
    if (r.textContent.length >= 300) return r;
  }

  // 策略 2: 降级选择器
  const fallback = fallbackExtract();
  if (fallback) return fallback;

  // 策略 3: 段落收集
  const brute = bruteForceExtract();
  if (brute) return brute;

  // 策略 4: Shadow DOM 展开 + 密度评分
  // 处理 Web Components / 非标准结构
  expandShadowDOMs();
  const clone2 = document.cloneNode(true) as Document;
  const article2 = new Readability(clone2).parse();
  if (article2 && article2.content && article2.length > 200) {
    return makeResult(article2);
  }
  const density = densityExtract();
  if (density) return density;

  // 策略 5: JSON-LD 提取 —— 不依赖 DOM，直接从结构化数据取正文
  return jsonldExtract();
}

// ===== 公共工具 =====
function makeResult(article: any): ExtractedContent {
  const clean = sanitizeHtml(article.content);
  return {
    title: article.title || document.title,
    content: clean,
    textContent: stripHtml(clean),
    excerpt: article.excerpt || "",
    byline: article.byline || null,
    siteName: article.siteName || null,
    length: article.length || clean.length,
  };
}

// ===== 快通道：降级选择器 =====
function fallbackExtract(): ExtractedContent | null {
  const selectors = [
    "article", '[role="main"]', '[role="article"]', "main",
    ".article-content", ".post-content", ".entry-content", ".content-body",
    "#article-body", "#story-body", ".story-body", ".article-body",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent?.trim() || "";
    if (text.length < 200) continue;
    return {
      title: extractTitle(),
      content: el.innerHTML,
      textContent: text,
      excerpt: text.slice(0, 200),
      byline: extractByline(),
      siteName: extractSiteName(),
      length: text.length,
    };
  }
  return null;
}

// ===== 快通道：段落收集 =====
function bruteForceExtract(): ExtractedContent | null {
  const paragraphs = Array.from(document.querySelectorAll("p")).filter((p) => {
    const text = p.textContent?.trim() || "";
    return text.length > 30 && !isAdOrNav(p);
  });
  if (paragraphs.length === 0) return null;

  const bodies = findContentBodies(paragraphs);
  const content = bodies.length > 0
    ? bodies.map((b) => b.innerHTML).join("")
    : paragraphs.map((p) => p.outerHTML).join("");

  const textContent = stripHtml(content);
  if (textContent.length < 100) return null;

  return {
    title: extractTitle(),
    content,
    textContent,
    excerpt: textContent.slice(0, 200),
    byline: extractByline(),
    siteName: extractSiteName(),
    length: textContent.length,
  };
}

function findContentBodies(paragraphs: Element[]): Element[] {
  const counts = new Map<Element, number>();
  for (const p of paragraphs) {
    let el = p.parentElement;
    let depth = 0;
    while (el && el !== document.body && depth < 5) {
      counts.set(el, (counts.get(el) || 0) + 1);
      el = el.parentElement;
      depth++;
    }
  }
  let best: Element | null = null;
  let bestCount = 0;
  for (const [el, count] of counts) {
    if (count > bestCount) { bestCount = count; best = el; }
  }
  return best ? [best] : [];
}

function isAdOrNav(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "nav") return true;
  const cls = (el.className || "") + " " + (el.id || "");
  const kws = ["ad","advertisement","sponsor","promo","banner","sidebar","nav","footer","menu","comment"];
  return kws.some((k) => cls.toLowerCase().includes(k));
}

// ===== 慢通道：Shadow DOM 展开 =====
function expandShadowDOMs(): void {
  document.querySelectorAll(".ir-shadow-expand").forEach(el => el.remove());

  function walk(el: Element): void {
    const shadow = (el as any).shadowRoot as ShadowRoot | null;
    if (shadow && shadow.textContent && shadow.textContent.trim().length > 200) {
      const c = document.createElement("div");
      c.className = "ir-shadow-expand";
      c.style.cssText = "position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;white-space:normal;pointer-events:none";
      c.innerHTML = shadow.innerHTML;
      el.parentNode?.insertBefore(c, el.nextSibling);
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
  }
  walk(document.body);
}

// ===== 慢通道：文本密度评分 =====
function densityExtract(): ExtractedContent | null {
  const scored: { el: Element; score: number; textLen: number }[] = [];

  function walk(el: Element): void {
    const text = el.textContent?.trim() || "";
    const htmlLen = el.innerHTML.length;
    const textLen = text.length;
    const tag = el.tagName.toLowerCase();
    if (["script","style","noscript"].includes(tag)) return;

    if (textLen >= 80) {
      const density = htmlLen > 0 ? textLen / htmlLen : 0;
      let score = textLen * density;
      if (density < 0.05) score *= 0.2;
      scored.push({ el, score, textLen });
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
  }

  walk(document.body);
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  if (best.textLen < 200) return null;

  if (best.el.parentElement) {
    const ps = scored.find(s => s.el === best.el!.parentElement);
    if (ps && ps.textLen > best.textLen * 1.5 && ps.score > best.score * 0.4) best = ps;
  }

  const tc = best.el.textContent?.trim() || "";
  if (tc.length < 200) return null;

  return {
    title: extractTitle(),
    content: best.el.innerHTML,
    textContent: tc,
    excerpt: tc.slice(0, 200),
    byline: extractByline(),
    siteName: extractSiteName(),
    length: tc.length,
  };
}

// ===== 通用辅助函数 =====
function extractTitle(): string {
  const og = document.querySelector('meta[property="og:title"]');
  if (og) return og.getAttribute("content") || document.title;
  return document.title;
}

function extractByline(): string | null {
  for (const s of ['meta[name="author"]','meta[property="article:author"]','[rel="author"]','.author','.byline']) {
    const el = document.querySelector(s);
    if (!el) continue;
    const text = el.getAttribute("content") || el.textContent?.trim() || "";
    if (text) return text;
  }
  return null;
}

function extractSiteName(): string | null {
  const el = document.querySelector('meta[property="og:site_name"]');
  return el?.getAttribute("content") || null;
}

function sanitizeHtml(html: string): string {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    // Preserve LaTeX math: wrap MathJax script content in .ir-math span
    .replace(/<script\s+type="math\/[^"]+"[^>]*>([\s\S]*?)<\/script>/gi, '<span class="ir-math">$1</span>')
    // Remove other script tags (but keep the math ones we just wrapped)
    .replace(/<script(?!\s+type="math\/)[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/ on\w+="[^"]*"/gi, "")
    .replace(/ on\w+='[^']*'/gi, "")
    .replace(/ style="[^"]*"/gi, "")
    .replace(/ style='[^']*'/gi, "");

  // 移除非 img 元素的 width/height HTML 属性，防止固定宽高导致容器溢出
  // img 保留 width/height 以减少加载前的布局抖动 (CLS)，CSS max-width:100% 会覆盖 width
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = cleaned;
    tmp.querySelectorAll("[width],[height]").forEach(el => {
      if (el.tagName.toLowerCase() !== "img") {
        el.removeAttribute("width");
        el.removeAttribute("height");
      }
    });
    // 清理原页面代码块自带的行号和语言标签（CSDN/highlight.js/prismjs 等）
    // 这些元素脱离原页面 CSS 后会错位显示在代码块下方
    cleanCodeBlockDecorations(tmp);
    cleaned = tmp.innerHTML;
  } catch {
    // DOM 解析失败时降级为正则清理（可能误删 img 的属性，但不影响功能）
    cleaned = cleaned
      .replace(/\s+width="[^"]*"/gi, "")
      .replace(/\s+width='[^']*'/gi, "")
      .replace(/\s+height="[^"]*"/gi, "")
      .replace(/\s+height='[^']*'/gi, "");
  }
  return cleaned;
}

// 清理代码块装饰元素：行号、语言标签、复制按钮等
// 只做减法，不添加任何功能
function cleanCodeBlockDecorations(root: Element): void {
  // 1. 已知 class 的行号元素
  root.querySelectorAll(
    '.hljs-ln-numbers,.hljs-ln-n,.line-number,.line-num,.line-numbers,.ln-num,.ln-number,' +
    '[data-line-number],.code-line-number,.td-line-number,.blob-num'
  ).forEach(el => el.remove());

  // 2. pre 内的 ol/ul 纯数字行号
  root.querySelectorAll("pre > ol, pre > ul").forEach(list => {
    list.querySelectorAll("li").forEach(li => {
      if (/^\d+$/.test((li.textContent || "").trim())) li.remove();
    });
  });

  // 3. pre table 的纯数字首列
  root.querySelectorAll("pre table").forEach(table => {
    table.querySelectorAll("tr > td:first-child, tr > th:first-child").forEach(cell => {
      if (/^\d+$/.test((cell.textContent || "").trim())) cell.remove();
    });
  });

  // 4. 已知 class 的语言标签和工具栏
  root.querySelectorAll(
    '.code-language,.code-lang,.lang-label,.language-label,' +
    '.hljs-lang,.code-title,.code-toolbar,.toolbar'
  ).forEach(el => el.remove());

  // 5. pre 内的纯数字行号 span
  root.querySelectorAll("pre").forEach(pre => {
    pre.querySelectorAll('span[class*="number"], span[class*="line-num"], span[class*="ln-num"]').forEach(span => {
      if (/^\d+$/.test((span.textContent || "").trim())) span.remove();
    });
  });

  // 6. pre 后面紧邻的 ul/ol：如果所有 li 都是纯数字且递增，整条移除（CSDN 行号）
  root.querySelectorAll("pre").forEach(pre => {
    let sibling = pre.nextElementSibling;
    while (sibling && (sibling.tagName === "UL" || sibling.tagName === "OL")) {
      const items = sibling.querySelectorAll("li");
      let allNumbers = items.length > 0;
      let prevNum = 0;
      for (const li of Array.from(items)) {
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

  // 7. pre 后面紧邻的短文本：如果看起来像语言名（<15字符），移除
  const LANG_RE = /^(xml|html|css|javascript|js|typescript|ts|java|python|bash|shell|sql|json|yaml|yml|go|rust|c|c\+\+|cpp|c#|cs|ruby|php|swift|kotlin|dart|vue|react|markdown|md|plain|text|ini|conf|nginx|dockerfile|makefile|protobuf|gradle|maven|pom)$/i;
  root.querySelectorAll("pre").forEach(pre => {
    let sibling = pre.nextElementSibling;
    let count = 0;
    while (sibling && count < 3) {
      const tag = sibling.tagName.toLowerCase();
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
      if (["pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "hr"].includes(tag)) break;
      break;
    }
  });
}

function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent?.replace(/\s+/g, " ").trim() || "";
}

// ===== 兜底提取：JSON-LD 结构化数据 =====
function jsonldExtract(): ExtractedContent | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const raw = JSON.parse(script.textContent || "{}");
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const type = item["@type"] || "";
        if (type !== "NewsArticle" && type !== "Article" && type !== "WebPage") continue;
        const body = item.articleBody || item.description || "";
        if (typeof body !== "string" || body.length < 300) continue;

        const title = item.headline || item.name || extractTitle();
        const author = item.author?.name
          || (Array.isArray(item.author) ? item.author[0]?.name : null)
          || null;
        const publisher = item.publisher?.name || null;
        const content = "<p>" + esc(body.replace(/\n/g, "<br>")) + "</p>";

        return {
          title,
          content,
          textContent: body,
          excerpt: body.slice(0, 200),
          byline: author || extractByline(),
          siteName: publisher || extractSiteName(),
          length: body.length,
        };
      }
    } catch {}
  }
  return null;
}

export function esc(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
