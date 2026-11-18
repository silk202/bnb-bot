// FlashBolt overlay background bridge — copies the export script on demand.
try {
  browser ?? chrome;
} catch {}
const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "fb-copy-overlay") return false;
  navigator.clipboard.writeText(msg.text).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: String(err && err.message || err) }),
  );
  return true; // async response
});
