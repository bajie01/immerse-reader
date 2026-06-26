# ImmerseReader

一款 Edge/Chrome 浏览器插件（Manifest V3），把任意网页一键转换为 Kindle 式沉浸阅读视图。

## 核心特性

- **一键沉浸阅读**：把网页正文提取并重新渲染为干净、专注的阅读视图
- **5 层通用提取管线**：Readability 标准提取 → 降级选择器 → 段落收集 → Shadow DOM 展开 + 密度评分 → JSON-LD 结构化数据
- **业务边界阻塞**：三层判定（URL 启发式 + DOM 启发式 + Readability 质量门），对卡片流/列表页/首页等无主线正文的页面主动阻塞并给出原因
- **"仍然尝试"逃生舱**：阻塞后可绕过第 1/2 层启发式，直接跑第 3 层提取管线
- **4 套预设主题 + 自定义主题**：light / sepia / dark / green，支持自定义背景/文字/链接颜色
- **字号 / 字体 / 边距 / 行高** 可调，偏好持久化到 `chrome.storage.sync`
- **目录侧栏**：自动从正文标题生成，IntersectionObserver 高亮当前章节
- **顶部进度条**：实时滚动进度
- **数学公式支持**：保留并重渲染原页 KaTeX / MathJax
- **SPA 异步内容等待**：MutationObserver 等待 DOM 稳定后自动重试提取

## 技术栈

- **构建**：Vite + TypeScript（严格模式），多入口打包（content / background / popup）
- **依赖**：`@mozilla/readability`（提取引擎）
- **无前端框架**：纯 DOM + 内联 CSS，保持轻量

## 项目结构

```
reader/
├── src/
│   ├── content/
│   │   ├── index.ts          # 内容脚本：阅读视图构建、阻塞策略、消息处理
│   │   └── readability.ts    # 提取引擎：5 层管线 + 阻塞判定
│   ├── background/
│   │   └── service-worker.ts # 后台：快捷键/图标监听、消息转发
│   └── popup/
│       ├── index.html        # Popup 结构
│       ├── popup.ts          # Popup 逻辑：状态查询、控件绑定
│       └── popup.css         # Popup 样式
├── docs/
│   ├── project-evaluation.md # 项目评估报告（市场定位、架构、路线图）
│   └── remaining-phases.md   # 剩余阶段规划
├── manifest.json             # MV3 清单
├── vite.config.ts            # 构建配置
└── package.json
```

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（监听文件变化）
pnpm dev

# 构建
pnpm build
```

构建产物在 `dist/` 目录，在 Edge/Chrome 的 `edge://extensions` 中加载该目录即可。

## 使用

- 点击工具栏 ImmerseReader 图标，或按快捷键 `Alt+R`（Mac 为 `MacCtrl+R`）进入/退出阅读模式
- 在 Popup 中调整主题、字号、字体、边距、行高
- 不兼容的页面会显示阻塞原因，可点"仍然尝试"强行提取

## 开发阶段

- **Phase 0（已完成）**：阅读视图核心、提取引擎、主题/控件、进度条/目录、SPA 等待、数学公式
- **Phase 1（进行中）**：阻塞策略已完成；SPA 路由检测、中文排版打磨等待启动
- **Phase 2+**：AI 摘要/问答、标注/导出/阅读列表等

详见 [docs/remaining-phases.md](docs/remaining-phases.md)。
