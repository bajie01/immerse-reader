// ImmerseReader — Popup
const $ = (id: string) => document.getElementById(id)!;

let readerActive = false;
let workerOk = true;

// ===== 阻塞态视图切换 =====
function showBlockView(reason: string) {
  $("blockReason").textContent = reason;
  $("blockView").hidden = false;
  $("mainView").hidden = true;
}

function hideBlockView() {
  $("blockView").hidden = true;
  $("mainView").hidden = false;
}

// Query state via background worker.  If worker is dead, try direct content script.
function queryState() {
  workerOk = true;
  chrome.runtime.sendMessage({ action: "getReaderState" }, (res) => {
    if (chrome.runtime.lastError) {
      workerOk = false;
      // Background worker might be down — try direct
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab?.id) { setState(false); return; }
        chrome.tabs.sendMessage(tab.id, { action: "getState" }, (r) => {
          setState(r?.active === true);
        });
      });
      return;
    }
    setState(res?.active === true);
  });
}

function setState(active: boolean) {
  readerActive = active;
  updateUI();
}

function updateUI() {
  const btn = $("toggleBtn") as HTMLButtonElement;
  const status = $("status");
  if (readerActive) {
    btn.textContent = "退出阅读模式";
    btn.classList.add("active");
    status.textContent = "阅读模式已开启";
  } else {
    btn.textContent = "进入阅读模式";
    btn.classList.remove("active");
    if (workerOk) status.textContent = "已就绪";
    else status.textContent = "重新连接…";
  }
}

function sendToContent(action: string, payload?: Record<string, unknown>) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { action, ...payload }).catch(() => {});
  });
}

// Toggle — always goes through background worker for robustness
$("toggleBtn").addEventListener("click", () => {
  // If background worker appears dead, try waking it
  if (!workerOk) {
    // Send a dummy message to wake the worker
    chrome.runtime.sendMessage({ action: "ping" }, () => {
      if (!chrome.runtime.lastError) workerOk = true;
    });
  }
  chrome.runtime.sendMessage({ action: "toggleFromPopup" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      // worker 不可用，降级：稍后重试查询
      setTimeout(queryState, 500);
      return;
    }
    if (res.blocked) {
      // 命中业务边界 → 显示阻塞态
      showBlockView(res.reason || "页面不兼容阅读模式");
    } else {
      hideBlockView();
      setTimeout(queryState, 500);
    }
  });
});

// 逃生舱：跳过第 1/2 层启发式，直接跑第 3 层提取
$("forceLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ action: "forceFromPopup" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setTimeout(queryState, 500);
      return;
    }
    if (res.blocked) {
      // 第 3 层也失败：明确告知用户，不再二次逃生
      showBlockView(res.reason || "自动提取失败，未找到可阅读正文");
    } else {
      hideBlockView();
      setTimeout(queryState, 500);
    }
  });
});

// Theme
document.querySelectorAll(".theme-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".theme-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    sendToContent("updateTheme", { theme: btn.getAttribute("data-theme") });
  });
});

// Custom theme colors
const customBg = $("customBg");
const customText = $("customText");
const customLink = $("customLink");
[customBg, customText, customLink].forEach(function(p) {
  p.addEventListener("input", function() {
    document.querySelectorAll(".theme-btn").forEach(function(b) { b.classList.remove("active"); });
    sendToContent("updateCustomTheme", { bg: customBg.value, text: customText.value, link: customLink.value });
  });
});
// Font size
let fontSize = 18;
$("fontSmall").addEventListener("click", () => {
  fontSize = Math.max(14, fontSize - 2);
  $("fontSizeLabel").textContent = String(fontSize);
  sendToContent("updateFontSize", { size: fontSize });
});
$("fontLarge").addEventListener("click", () => {
  fontSize = Math.min(32, fontSize + 2);
  $("fontSizeLabel").textContent = String(fontSize);
  sendToContent("updateFontSize", { size: fontSize });
});

// Font family
$("fontSelect").addEventListener("change", (e) => {
  sendToContent("updateFontFamily", { family: (e.target as HTMLSelectElement).value });
});

// Margin & line height
$("marginSlider").addEventListener("input", function(e) {
  var val = e.target.value;
  $("marginLabel").textContent = val;
  sendToContent("updateMargin", { margin: parseInt(val) });
});
$("lineHeightSlider").addEventListener("input", function(e) {
  var val = e.target.value;
  var lh = (parseInt(val) / 10).toFixed(1);
  $("lineHeightLabel").textContent = lh;
  sendToContent("updateLineHeight", { lineHeight: parseFloat(lh) });
});

// Load saved preferences
chrome.storage.sync.get(["irTheme","irFontSize","irFontFamily","irCustomBg","irCustomText","irCustomLink","irMargin","irLineHeight"], (prefs) => {
  if (prefs.irTheme) {
    document.querySelector(`[data-theme="${prefs.irTheme}"]`)?.classList.add("active");
  }
  if (prefs.irFontSize) {
    fontSize = prefs.irFontSize as number;
    $("fontSizeLabel").textContent = String(fontSize);
  }
  if (prefs.irFontFamily) {
    ($("fontSelect") as HTMLSelectElement).value = prefs.irFontFamily as string;
  }
  if (prefs.irCustomBg) customBg.value = prefs.irCustomBg;
  if (prefs.irCustomText) customText.value = prefs.irCustomText;
  if (prefs.irCustomLink) customLink.value = prefs.irCustomLink;
  if (prefs.irMargin) { $("marginSlider").value = String(prefs.irMargin); $("marginLabel").textContent = String(prefs.irMargin); }
  if (prefs.irLineHeight) { var lh = Math.round(prefs.irLineHeight * 10); $("lineHeightSlider").value = String(lh); $("lineHeightLabel").textContent = prefs.irLineHeight.toFixed(1); }
});

queryState();
