// Service worker. Two jobs:
//   1. Download a car's photos from the dealer's image host (the extension has
//      permission for that host; the Facebook page itself does not) and hand
//      them to the side panel as data URLs.
//   2. Open the side panel when the popup can't.
// It never touches Facebook and never posts anything.

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function downloadPhoto(url, index) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return { url, ok: false, error: 'HTTP ' + res.status };
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_PHOTO_BYTES) return { url, ok: false, error: 'too large' };
    const ext = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : 'jpg';
    return {
      url,
      ok: true,
      name: `photo-${String(index + 1).padStart(2, '0')}.${ext}`,
      type,
      bytes: buffer.byteLength,
      dataUrl: `data:${type};base64,${toBase64(buffer)}`,
    };
  } catch (e) {
    return { url, ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'downloadPhotos') {
    const urls = Array.isArray(msg.urls) ? msg.urls.slice(0, 10) : [];
    Promise.all(urls.map((u, i) => downloadPhoto(u, (msg.offset || 0) + i))).then((photos) => sendResponse({ ok: true, photos }));
    return true;
  }
  if (msg.type === 'openSidePanel') {
    const target = msg.windowId ? { windowId: msg.windowId } : { tabId: msg.tabId };
    chrome.sidePanel.open(target).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar icon keeps opening the popup; the side panel is opened from "Post".
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});
