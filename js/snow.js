(function () {
  "use strict";

  var canvas = document.getElementById("snow-canvas");
  if (!canvas) {
    return;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  var ctx = canvas.getContext("2d");
  var flakes = [];
  var width = 0;
  var height = 0;
  var animationId = 0;
  var flakeCount = 120;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width;
    canvas.height = height;

    if (flakes.length === 0) {
      createFlakes();
    } else {
      flakes.forEach(function (flake) {
        if (flake.y > height) {
          flake.y = randomBetween(0, height);
        }
        if (flake.x > width) {
          flake.x = randomBetween(0, width);
        }
      });
    }
  }

  function createFlakes() {
    var i;
    flakes = [];
    flakeCount = Math.max(60, Math.min(180, Math.floor((width * height) / 12000)));

    for (i = 0; i < flakeCount; i++) {
      flakes.push(makeFlake(true));
    }
  }

  function makeFlake(scatter) {
    return {
      x: randomBetween(0, width),
      y: scatter ? randomBetween(0, height) : randomBetween(-20, -2),
      radius: randomBetween(1, 3.2),
      speed: randomBetween(0.6, 2.4),
      drift: randomBetween(-0.35, 0.35),
      opacity: randomBetween(0.35, 0.95),
      wobble: randomBetween(0, Math.PI * 2),
      wobbleSpeed: randomBetween(0.01, 0.04)
    };
  }

  function resetFlake(flake) {
    flake.x = randomBetween(0, width);
    flake.y = randomBetween(-20, -2);
    flake.radius = randomBetween(1, 3.2);
    flake.speed = randomBetween(0.6, 2.4);
    flake.drift = randomBetween(-0.35, 0.35);
    flake.opacity = randomBetween(0.35, 0.95);
    flake.wobble = randomBetween(0, Math.PI * 2);
    flake.wobbleSpeed = randomBetween(0.01, 0.04);
  }

  function snowColor() {
    var theme = document.documentElement.getAttribute("data-theme");
    var dark = theme === "dark";

    if (theme === "system") {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    return dark ? "rgba(230, 240, 255, " : "rgba(255, 255, 255, ";
  }

  function draw() {
    var i;
    var flake;
    var colorPrefix = snowColor();

    ctx.clearRect(0, 0, width, height);

    for (i = 0; i < flakes.length; i++) {
      flake = flakes[i];
      flake.y += flake.speed;
      flake.wobble += flake.wobbleSpeed;
      flake.x += flake.drift + Math.sin(flake.wobble) * 0.4;

      if (flake.y > height + flake.radius) {
        resetFlake(flake);
      }

      if (flake.x < -flake.radius) {
        flake.x = width + flake.radius;
      } else if (flake.x > width + flake.radius) {
        flake.x = -flake.radius;
      }

      ctx.beginPath();
      ctx.arc(flake.x, flake.y, flake.radius, 0, Math.PI * 2);
      ctx.fillStyle = colorPrefix + flake.opacity + ")";
      ctx.fill();
    }

    animationId = window.requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener("resize", resize);
  draw();

  window.addEventListener("beforeunload", function () {
    window.cancelAnimationFrame(animationId);
  });
})();
