// Applies the saved theme before first paint (no dark→light flash).
// theme.ts keeps localStorage in sync with chrome.storage.
(function () {
    var pref = localStorage.getItem("wtTheme") || "system";
    var light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
})();
