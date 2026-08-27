/* ==========================================================================
   Sous docs — terminal demos
   --------------------------------------------------------------------------
   A small docsify plugin that turns ```term fenced blocks into termynal
   containers and plays each demo the FIRST time it scrolls into view.

   The animation engine is termynal.js (MIT), loaded from the CDN pin in
   docs/docs/index.html (termynal/termynal.py @ v0.14.0). This file is
   site-owned glue, not a third-party library.

   Fence line syntax:
     $ command      typed input (the $ prompt is drawn by CSS)
     // text        a subtle comment line
     >> 100%        an animated progress bar
     anything else  printed output
     (blank line)   spacer

   Fences must start at column 0 (`^```term`). An INDENTED ```term block is
   deliberately left alone, which is how the authoring docs show the syntax
   literally inside another fence.
   ========================================================================== */

(function () {
  "use strict";

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function lineToSpan(line) {
    if (line.indexOf("$ ") === 0) {
      return '<span data-ty="input">' + escapeHtml(line.slice(2)) + "</span>";
    }
    if (line.indexOf("// ") === 0) {
      return '<span data-ty class="term-comment">' + escapeHtml(line.slice(3)) + "</span>";
    }
    if (line.indexOf(">> ") === 0) {
      return '<span data-ty="progress"></span>';
    }
    if (line.trim() === "") {
      return "<span data-ty></span>";
    }
    return "<span data-ty>" + escapeHtml(line) + "</span>";
  }

  function fenceToTermynal(_match, body) {
    var spans = body.replace(/\n$/, "").split("\n").map(lineToSpan).join("\n  ");
    return (
      '<div class="term-demo" data-termynal data-ty-title="terminal" ' +
      'data-ty-typeDelay="35" data-ty-lineDelay="600" data-ty-startDelay="300">\n  ' +
      spans +
      "\n</div>"
    );
  }

  function transform(content) {
    return content.replace(/^```term\n([\s\S]*?)^```$/gm, fenceToTermynal);
  }

  var observer = null;

  function getObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          var demo = entry.target.__termynal;
          if (demo) demo.init();
        });
      },
      { threshold: 0.3 }
    );
    return observer;
  }

  function armDemos() {
    if (typeof Termynal !== "function") return;
    document.querySelectorAll(".term-demo:not([data-term-armed])").forEach(function (node) {
      node.setAttribute("data-term-armed", "");
      node.__termynal = new Termynal(node, { noInit: true });
      getObserver().observe(node);
    });
  }

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = [].concat(window.$docsify.plugins || [], function (hook) {
    hook.beforeEach(transform);
    hook.doneEach(armDemos);
  });
})();
