(function () {
  "use strict";

  var THEME_KEY = "theme";
  var VALID_THEMES = ["light", "dark", "system"];

  function getStoredTheme() {
    try {
      var stored = localStorage.getItem(THEME_KEY);
      return VALID_THEMES.indexOf(stored) !== -1 ? stored : "system";
    } catch (e) {
      return "system";
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);

    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* ignore storage errors */
    }

    document.querySelectorAll("[data-theme-choice]").forEach(function (btn) {
      var isActive = btn.getAttribute("data-theme-choice") === theme;
      btn.setAttribute("aria-pressed", String(isActive));
    });
  }

  applyTheme(getStoredTheme());

  document.querySelectorAll("[data-theme-choice]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      applyTheme(btn.getAttribute("data-theme-choice"));
    });
  });

  // Mobile navigation toggle
  var navToggle = document.querySelector(".nav-toggle");
  var siteNav = document.getElementById("site-nav");

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", function () {
      var isOpen = siteNav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });

    siteNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        siteNav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

})();
