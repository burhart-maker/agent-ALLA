// Download page behaviour: pick the right install instructions for the
// device that's actually asking, and offer the real one-click install where
// the browser supports it.
(function () {
  var tabs = document.getElementById("tabs");
  var panels = document.querySelectorAll(".platform-panel");
  var installBtn = document.getElementById("install-btn");
  var openBtn = document.getElementById("open-btn");

  function show(p) {
    var buttons = tabs.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-selected", String(buttons[i].dataset.p === p));
    }
    for (var j = 0; j < panels.length; j++) {
      panels[j].hidden = panels[j].dataset.p !== p;
    }
  }

  function guessPlatform() {
    var ua = navigator.userAgent || "";
    var touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1; // iPadOS
    if (/iPhone|iPad|iPod/i.test(ua) || touchMac) return "ios";
    if (/Android/i.test(ua)) return "android";
    return "desktop";
  }

  tabs.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-p]");
    if (btn) show(btn.dataset.p);
  });
  show(guessPlatform());

  // Chrome/Edge fire this when the site qualifies as installable. Capturing
  // it lets the page offer a real install button instead of only telling
  // people where to find the browser's own menu item. Safari/iOS never fire
  // it — the written steps stay as the answer there.
  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
    openBtn.className = "btn secondary";
  });

  installBtn.addEventListener("click", async function () {
    if (!deferred) return;
    installBtn.disabled = true;
    deferred.prompt();
    try { await deferred.userChoice; } catch (err) { /* dismissed */ }
    deferred = null;
    installBtn.hidden = true;
    installBtn.disabled = false;
    openBtn.className = "btn";
  });

  window.addEventListener("appinstalled", function () {
    installBtn.hidden = true;
    openBtn.className = "btn";
  });

  // Already running as an installed app? Then the install card is noise.
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
    installBtn.hidden = true;
  }
})();
