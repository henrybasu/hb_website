(function () {
  "use strict";

  var art = document.querySelector(".ascii-art--fullscreen");
  var stage = document.querySelector(".ascii-stage");
  if (!art) {
    return;
  }

  function fitArt() {
    var lines = art.textContent.split("\n");
    var colCount = 0;
    var i;
    var availWidth;
    var availHeight;
    var rect;
    var scale;

    for (i = 0; i < lines.length; i++) {
      if (lines[i].length > colCount) {
        colCount = lines[i].length;
      }
    }

    art.style.fontSize = "16px";
    art.style.lineHeight = "1.1";

    rect = art.getBoundingClientRect();
    availWidth = stage ? stage.clientWidth : window.innerWidth;
    availHeight = stage ? stage.clientHeight : window.innerHeight;
    scale = Math.min(availWidth / rect.width, availHeight / rect.height);

    art.style.fontSize = Math.floor(16 * scale * 0.98) + "px";
  }

  fitArt();
  window.addEventListener("resize", fitArt);
})();
