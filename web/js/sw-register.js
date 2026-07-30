// Service-worker registration. In its own file rather than an inline <script>
// so the Content-Security-Policy doesn't need script 'unsafe-inline' — inline
// script is the main thing a CSP exists to block.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}
