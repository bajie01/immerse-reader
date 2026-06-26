// ImmerseReader — Service Worker
// IMPORTANT: wrap everything in try-catch. In MV3, unhandled errors kill the worker.

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-reader") toggleReaderOnActiveTab(false);
});

chrome.action.onClicked.addListener(() => {
  toggleReaderOnActiveTab(false);
});

// Toggle or force-toggle reader on the active tab.
// force=true bypasses the URL/DOM heuristic block layers (逃生舱).
// Returns the content-script response (includes blocked/reason when blocked).
async function toggleReaderOnActiveTab(force: boolean): Promise<any> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { active: false };
    if (!tab.url || /^(edge|chrome|about):/.test(tab.url)) return { active: false };

    const action = force ? "forceReader" : "toggleReader";

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action });
      if (resp?.active !== undefined) {
        await chrome.storage.local.set({ irActive: resp.active });
        return resp;
      }
    } catch {
      // not injected — will inject below
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await new Promise(r => setTimeout(r, 200));

    // Re-query tab: SPA pages (e.g. MSN) may navigate during injection
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetId = currentTab?.id;
    if (!targetId) { console.warn("ImmerseReader: tab gone after injection"); return { active: false }; }

    const resp = await chrome.tabs.sendMessage(targetId, { action });
    await chrome.storage.local.set({ irActive: resp?.active ?? false });
    return resp || { active: false };
  } catch (e) {
    console.error("ImmerseReader: toggle failed", e);
    return { active: false };
  }
}

// Handle messages from popup.  Every handler must catch its own errors.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.action) {
      case "getReaderState":
        handleGetReaderState(sendResponse);
        return true; // async response

      case "toggleFromPopup":
        handleToggleFromPopup(sendResponse, false);
        return true; // async response

      case "forceFromPopup":
        handleToggleFromPopup(sendResponse, true);
        return true; // async response

      default:
        return false;
    }
  } catch (e) {
    console.error("ImmerseReader: unhandled error in onMessage", e);
    sendResponse?.({ error: true });
    return true;
  }
});

async function handleGetReaderState(sendResponse: (resp: any) => void) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { sendResponse({ active: false }); return; }

    // Always query the active tab's content script.
    // No global storage fallback: each tab's state is independent.
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action: "getState" });
      sendResponse(resp || { active: false });
    } catch {
      // Content script not injected yet — try to inject
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
        });
      } catch {}
      sendResponse({ active: false });
    }
  } catch (e) {
    console.error("ImmerseReader: getReaderState error", e);
    sendResponse({ active: false });
  }
}

async function handleToggleFromPopup(sendResponse: (resp: any) => void, force: boolean) {
  try {
    const resp = await toggleReaderOnActiveTab(force);
    // 透传 content script 的响应（含 blocked/reason）
    sendResponse({ ok: true, ...resp });
  } catch (e) {
    console.error("ImmerseReader: toggleFromPopup error", e);
    sendResponse({ ok: false });
  }
}
