/* ============================================================
   PrimeBizValue — shared theme behaviour
   Injects the scroll-progress bar and toggles the frosted nav.
   Everything here is progressive enhancement: with JS off the
   page renders exactly as it does without this file.
   ============================================================ */

(function () {
  'use strict';

  var root = document.documentElement;

  /* --- scroll progress bar (injected, no markup required) --- */
  var bar = null;
  if (!document.querySelector('.pbv-progress')) {
    var wrap = document.createElement('div');
    wrap.className = 'pbv-progress';
    var fill = document.createElement('i');
    wrap.appendChild(fill);
    document.body.appendChild(wrap);
    bar = fill;
  } else {
    bar = document.querySelector('.pbv-progress i');
  }

  var ticking = false;

  function update() {
    var y = window.pageYOffset || root.scrollTop || 0;

    if (y > 8) root.classList.add('pbv-stuck');
    else root.classList.remove('pbv-stuck');

    if (bar) {
      var max = root.scrollHeight - window.innerHeight;
      var p = max > 0 ? Math.min(y / max, 1) : 0;
      bar.style.transform = 'scaleX(' + p + ')';
    }

    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  }, { passive: true });

  window.addEventListener('resize', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  }, { passive: true });

  update();
})();
