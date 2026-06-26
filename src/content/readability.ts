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

  // 判定 B: 无 <article> 且长段落（>200 字）不足 3 个 且段落数 ≥ 5 → 卡片流
  const hasArticle = !!doc.querySelector("article, [role='article'], [role='main'], main");
  const longParagraphs = paragraphs.filter((p) => (p.textContent || "").trim().length > 200);
  if (!hasArticle && longParagraphs.length < 3 && paragraphs.length >= 5) {
    return { layer: "dom", reason: "检测为卡片流页面（缺少连续长文段落）" };
  }

  // 判定 C: 段落普遍过短（中位数 < 40 字）且段落数较多 → 卡片流
  if (paragraphs.length >= 8 && paragraphs.length < 500) {
    const lens = paragraphs.map((p) => (p.textContent || "").trim().length).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)];
    if (median < 40 && longParagraphs.length < 2) {
      return { layer: "dom", reason: "检测为卡片流页面（段落普遍过短）" };
    }
  }

  // 判定 D: iframe 主导 → 应用页
  const iframes = Array.from(doc.querySelectorAll("iframe"));
  if (iframes.length >= 1 && longParagraphs.length < 2) {
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
// Math protection: preserve KaTeX/MathJax/MathML through Readability
export function extractContent(): ExtractedContent | null {
  // 策略 1: Readability 标准提取
  const clone = document.cloneNode(true) as Document;
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
  return html
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
