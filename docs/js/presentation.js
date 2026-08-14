/* ==========================================================================
   Sous — landing-page presentation
   --------------------------------------------------------------------------
   One master gsap.timeline({ paused: true }) is the single source of truth;
   one child timeline per scene, with a label at each scene start. Two playhead
   drivers, never simultaneously active:
     - playing: GSAP's ticker (UI renders from the timeline's onUpdate)
     - paused:  an Observer maps wheel/touch/pointer deltas onto a smoothed
                progress tween (gsap.quickTo)
   ========================================================================== */

(function () {
  "use strict";

  if (!window.gsap || !window.Observer) {
    // CDN failed: leave the static title scene visible, hide the player chrome.
    document.documentElement.classList.add("no-gsap");
    return;
  }

  gsap.registerPlugin(Observer);

  /* ----- Elements ---------------------------------------------------------- */
  var player = document.getElementById("player");
  var stage = document.getElementById("stage");
  var playPauseBtn = document.getElementById("playPause");
  var introPlayBtn = document.getElementById("introPlay");
  var scrubInput = document.getElementById("scrubRange");
  var segmentsEl = document.getElementById("sceneSegments");

  /* ----- Scenes (order = presentation order; ids match data-scene attrs) ----
     The "what"/"problems"/"how" sections are RETIRED: their markup stays in
     index.html for reference, but omitting them here keeps them hidden (the
     base .scene CSS starts every section at opacity 0 / visibility hidden). */
  var SCENES = [
    { id: "intro", title: "Intro", hold: 4.8 },
    { id: "features", title: "Core Systems", hold: 7.2 },
    { id: "aggregator", title: "Aggregator", hold: 10 },
    { id: "templates", title: "Templates", hold: 4 }, // callout sequence supplies most of the dwell time
    { id: "why", title: "Why?", hold: 7.2 },
    { id: "teams-statement", title: "Teams", hold: 7.2 },
    { id: "teams-status-quo", title: "Teams: Today", hold: 10 },
    { id: "teams-mitigation", title: "Teams: Sous", hold: 10 },
    { id: "teams-example", title: "Teams: Demo", hold: 11 },
    { id: "teams-alternatives", title: "Teams: Alts", hold: 10 },
    { id: "projects-statement", title: "Projects", hold: 7.2 },
    { id: "projects-status-quo", title: "Projects: Today", hold: 10 },
    { id: "projects-mitigation", title: "Projects: Sous", hold: 10 },
    { id: "projects-example", title: "Projects: Demo", hold: 11 },
    { id: "projects-alternatives", title: "Projects: Alts", hold: 10 },
    { id: "tools-statement", title: "Tools", hold: 7.2 },
    { id: "tools-status-quo", title: "Tools: Today", hold: 10 },
    { id: "tools-mitigation", title: "Tools: Sous", hold: 10 },
    { id: "tools-example", title: "Tools: Demo", hold: 11 },
    { id: "tools-alternatives", title: "Tools: Alts", hold: 10 },
    { id: "tokens-statement", title: "Tokens", hold: 7.2 },
    { id: "tokens-status-quo", title: "Tokens: Today", hold: 10 },
    { id: "tokens-mitigation", title: "Tokens: Sous", hold: 10 },
    { id: "tokens-example", title: "Tokens: Demo", hold: 11 },
    { id: "tokens-alternatives", title: "Tokens: Alts", hold: 10 },
    { id: "stale-statement", title: "Stale", hold: 7.2 },
    { id: "stale-status-quo", title: "Stale: Today", hold: 10 },
    { id: "stale-mitigation", title: "Stale: Sous", hold: 10 },
    { id: "stale-example", title: "Stale: Demo", hold: 11 },
    { id: "stale-alternatives", title: "Stale: Alts", hold: 10 },
    { id: "speed-statement", title: "Speed", hold: 7.2 },
    { id: "speed-status-quo", title: "Speed: Today", hold: 10 },
    { id: "speed-mitigation", title: "Speed: Sous", hold: 12 },
    { id: "speed-example", title: "Speed: Demo", hold: 11 },
    { id: "speed-alternatives", title: "Speed: Alts", hold: 10 },
    { id: "docs-statement", title: "Docs", hold: 7.2 },
    { id: "docs-status-quo", title: "Docs: Today", hold: 10 },
    { id: "docs-mitigation", title: "Docs: Sous", hold: 10 },
    { id: "docs-example", title: "Docs: Demo", hold: 11 },
    { id: "docs-alternatives", title: "Docs: Alts", hold: 10 },
    { id: "philosophy-augment", title: "Augment", hold: 6 },
    { id: "philosophy-collective", title: "The Gaps", hold: 6 },
    { id: "philosophy-unopinionated", title: "No Opinions", hold: 6 },
    { id: "philosophy-enter", title: "Easy In", hold: 6 },
    { id: "philosophy-exit", title: "Easy Out", hold: 6 },
    { id: "outro", title: "Get Started", hold: 2.4 }
  ];

  function sceneEl(id) {
    return stage.querySelector('[data-scene="' + id + '"]');
  }

  /* ----- Problem-slide kickers (generated; single source of truth) -----------
     Every problem slide's heading is `(pill) Problem #<x>: <brief>`. It is
     built here, from this table, so its format can be changed in ONE place.
     Scene ids follow `<problem>-<slide-type>`. */
  var PROBLEMS = {
    teams: { num: 1, brief: "Shared Configs Fork Instantly" },
    projects: { num: 2, brief: "Every Project Starts Over" },
    tools: { num: 3, brief: "Tool Switches Hurt" },
    tokens: { num: 4, brief: "Context Is Expensive" },
    stale: { num: 5, brief: "Hand-Written Lists Rot" },
    speed: { num: 6, brief: "Sessions Crawl" },
    docs: { num: 7, brief: "Scattered Docs Drift Apart" }
  };

  var SLIDE_TYPE_LABELS = {
    "statement": "Statement",
    "status-quo": "Status-Quo",
    "mitigation": "Mitigation",
    "example": "Example",
    "alternatives": "Alternatives"
  };

  (function buildProblemKickers() {
    Object.keys(PROBLEMS).forEach(function (key) {
      Object.keys(SLIDE_TYPE_LABELS).forEach(function (type) {
        var el = sceneEl(key + "-" + type);
        if (!el) { return; }
        var inner = el.querySelector(".scene-inner");
        var kicker = document.createElement("p");
        kicker.className = "kicker kicker-problem anim";
        var num = document.createElement("span");
        num.className = "kicker-num";
        num.textContent = "Problem #" + PROBLEMS[key].num;
        var brief = document.createElement("span");
        brief.className = "kicker-brief";
        brief.textContent = PROBLEMS[key].brief;
        var pill = document.createElement("span");
        pill.className = "pill pill-" + type;
        pill.textContent = SLIDE_TYPE_LABELS[type];
        kicker.appendChild(num);
        kicker.appendChild(pill);
        kicker.appendChild(brief);
        inner.insertBefore(kicker, inner.firstChild);
      });
    });
  })();

  /* ----- Philosophy-slide kickers (generated, like problem kickers) ---------
     One line: "Principle #<n>" with a (Philosophy) pill to its right. Order
     follows this list. */
  var PHILOSOPHY = [
    "philosophy-augment",
    "philosophy-collective",
    "philosophy-unopinionated",
    "philosophy-enter",
    "philosophy-exit"
  ];

  (function buildPhilosophyKickers() {
    PHILOSOPHY.forEach(function (id, i) {
      var el = sceneEl(id);
      if (!el) { return; }
      var inner = el.querySelector(".scene-inner");
      var kicker = document.createElement("p");
      kicker.className = "kicker kicker-problem anim";
      var num = document.createElement("span");
      num.className = "kicker-num";
      num.textContent = "Principle #" + (i + 1);
      var pill = document.createElement("span");
      pill.className = "pill pill-philosophy";
      pill.textContent = "Philosophy";
      kicker.appendChild(num);
      kicker.appendChild(pill);
      inner.insertBefore(kicker, inner.firstChild);
    });
  })();

  /* ----- State -------------------------------------------------------------- */
  var playing = false;
  var reducedMotion = false;
  var scrubTarget = 0;

  gsap.matchMedia().add("(prefers-reduced-motion: reduce)", function () {
    reducedMotion = true;
    return function () { reducedMotion = false; };
  });

  /* ----- Master timeline ----------------------------------------------------- */
  // Pre-hide everything GSAP will reveal (the intro scene starts visible).
  SCENES.forEach(function (scene) {
    var el = sceneEl(scene.id);
    if (scene.id !== "intro") {
      gsap.set(el, { autoAlpha: 0 });
      gsap.set(el.querySelectorAll(".anim"), { autoAlpha: 0, y: 24 });
    }
  });

  // Callout highlights/tooltips start hidden (CSS sets opacity: 0; this adds
  // visibility so autoAlpha tweens manage both). Output panes crossfade in
  // during their scene's sub-scene sequence.
  gsap.set(stage.querySelectorAll(".hl-bg, .hl-tip"), { autoAlpha: 0 });
  gsap.set(stage.querySelectorAll(".code-pane-output"), { autoAlpha: 0 });

  function sceneIn(el) {
    var t = gsap.timeline();
    t.set(el, { autoAlpha: 1 });
    t.fromTo(
      el.querySelectorAll(".anim"),
      { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.18, ease: "power2.out", immediateRender: false }
    );
    return t;
  }

  function sceneOut(el) {
    var t = gsap.timeline();
    t.to(el.querySelectorAll(".anim"), {
      autoAlpha: 0,
      y: -24,
      duration: 0.45,
      stagger: 0.05,
      ease: "power2.in"
    });
    t.set(el, { autoAlpha: 0 });
    return t;
  }

  // Highlight/tooltip callouts: fade each .hl in, dwell, fade it out, in
  // document order. Runs inside the master timeline, so play/scrub/jump all
  // drive it for free.
  function calloutsTimeline(container) {
    var t = gsap.timeline();
    container.querySelectorAll(".hl").forEach(function (hl) {
      var parts = hl.querySelectorAll(".hl-bg, .hl-tip");
      t.to(parts, { autoAlpha: 1, duration: 0.35 });
      t.to({}, { duration: 6 }); // dwell while the viewer reads the tooltip
      t.to(parts, { autoAlpha: 0, duration: 0.35 });
    });
    return t;
  }

  // Templates scene sub-scenes: walk through the template, crossfade to the
  // rendered output, walk through that.
  function templatesTimeline(el) {
    var tplPane = el.querySelector(".code-pane-template");
    var outPane = el.querySelector(".code-pane-output");
    var t = gsap.timeline();
    t.to({}, { duration: 1.6 }); // beat to take in the template
    t.add(calloutsTimeline(tplPane));
    t.to(tplPane, { autoAlpha: 0, duration: 0.45, ease: "power2.in" });
    t.fromTo(
      outPane,
      { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", immediateRender: false }
    );
    t.to({}, { duration: 1.6 }); // beat to take in the output
    t.add(calloutsTimeline(outPane));
    return t;
  }

  // Optional per-scene timeline extensions, added after the scene has entered.
  var SCENE_EXTRAS = {
    templates: templatesTimeline
  };

  var tl = gsap.timeline({ paused: true, onUpdate: syncUi, onComplete: onEnded });

  SCENES.forEach(function (scene, i) {
    var el = sceneEl(scene.id);
    var last = i === SCENES.length - 1;
    tl.addLabel(scene.id); // scene start: chapter-bar segment boundary
    if (scene.id !== "intro") {
      tl.add(sceneIn(el));
    }
    tl.addLabel(scene.id + "-shown"); // fully entered: the jump target
    if (SCENE_EXTRAS[scene.id]) {
      tl.add(SCENE_EXTRAS[scene.id](el));
    }
    tl.to({}, { duration: scene.hold }); // hold the scene on screen
    if (!last) {
      tl.addLabel(scene.id + "-exit"); // hold over, exit animation begins
      tl.add(sceneOut(el));
      tl.to({}, { duration: 0.3 }); // brief gap between scenes
    }
  });

  /* ----- Scrubbing (paused-mode playhead driver) ------------------------------ */
  var MAX_DELTA = 60;          // clamp per-tick wheel deltas (px)
  var SECONDS_PER_PIXEL = 0.02; // scrub speed: 60px notch ≈ 1.2s of timeline

  // quickTo provides the ONLY inertia; recreated whenever we kill tweens of tl.
  var progressTo = makeProgressTo();

  function makeProgressTo() {
    return gsap.quickTo(tl, "progress", { duration: 0.6, ease: "power3" });
  }

  // Kill any in-flight scrub/jump tween driving the timeline (required before
  // tl.play()), then rebuild the quickTo whose backing tween just died.
  function killScrubTweens() {
    gsap.killTweensOf(tl);
    progressTo = makeProgressTo();
  }

  var observer = Observer.create({
    target: stage,
    type: "wheel,touch,pointer",
    preventDefault: true, // only active while scrub mode is enabled, only over the stage
    onChangeY: function (self) {
      var delta = self.deltaY;
      if (self.event.type !== "wheel") {
        delta = -delta; // dragging up moves the presentation forward
      }
      delta = gsap.utils.clamp(-MAX_DELTA, MAX_DELTA, delta);
      scrubTarget = gsap.utils.clamp(0, 1, scrubTarget + (delta * SECONDS_PER_PIXEL) / tl.duration());
      if (reducedMotion) {
        tl.progress(scrubTarget);
      } else {
        progressTo(scrubTarget);
      }
    }
  });

  function enableScrub() {
    scrubTarget = tl.progress();
    observer.enable();
    player.classList.add("is-scrubbable");
  }

  function disableScrub() {
    observer.disable();
    player.classList.remove("is-scrubbable");
  }

  /* ----- Play / pause ---------------------------------------------------------- */
  function play() {
    killScrubTweens();
    disableScrub();
    if (tl.progress() > 0.999) {
      tl.progress(0); // replay from the top
    }
    // The title scene is static and already consumed by the time the user
    // presses play — skip the rest of its hold and transition away at once.
    if (tl.time() < tl.labels["intro-exit"]) {
      tl.seek("intro-exit");
    }
    playing = true;
    player.classList.add("is-playing");
    playPauseBtn.setAttribute("aria-label", "Pause presentation");
    tl.play();
  }

  function pause() {
    playing = false;
    tl.pause();
    killScrubTweens();
    player.classList.remove("is-playing");
    playPauseBtn.setAttribute("aria-label", "Play presentation");
    enableScrub();
  }

  function togglePlay() {
    if (playing) { pause(); } else { play(); }
  }

  function onEnded() {
    playing = false;
    player.classList.remove("is-playing");
    playPauseBtn.setAttribute("aria-label", "Replay presentation");
    enableScrub();
    syncUi();
  }

  /* ----- Scene jumps ------------------------------------------------------------ */
  function goToLabel(label) {
    var wasPlaying = playing;
    killScrubTweens();
    if (reducedMotion) {
      tl.seek(label); // instant under prefers-reduced-motion
      if (wasPlaying) { tl.play(); } else { scrubTarget = tl.progress(); }
      syncUi();
      return;
    }
    disableScrub();
    // tweenTo pauses the timeline and does NOT auto-resume; restore in onComplete.
    tl.tweenTo(label, {
      duration: 0.8,
      ease: "power2.inOut",
      onComplete: function () {
        if (wasPlaying) {
          tl.play();
        } else {
          enableScrub();
        }
      }
    });
  }

  function currentSceneIndex() {
    var t = tl.time();
    var idx = 0;
    SCENES.forEach(function (scene, i) {
      if (tl.labels[scene.id] <= t + 0.001) { idx = i; }
    });
    return idx;
  }

  function jumpScene(dir) {
    var idx = currentSceneIndex();
    var target = idx + dir;
    // Left in mid-scene returns to the current scene's resting point first.
    if (dir < 0 && tl.time() - tl.labels[SCENES[idx].id + "-shown"] > 0.5) {
      target = idx;
    }
    target = gsap.utils.clamp(0, SCENES.length - 1, target);
    goToLabel(SCENES[target].id + "-shown");
  }

  /* ----- Chapter bar -------------------------------------------------------------- */
  var segments = [];

  (function buildChapterBar() {
    var total = tl.duration();
    SCENES.forEach(function (scene, i) {
      var start = tl.labels[scene.id];
      var end = i < SCENES.length - 1 ? tl.labels[SCENES[i + 1].id] : total;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scene-btn";
      btn.style.flexGrow = String(end - start);
      btn.setAttribute("aria-label", "Go to scene: " + scene.title);

      var fill = document.createElement("span");
      fill.className = "scene-btn-fill";
      fill.setAttribute("aria-hidden", "true");

      var title = document.createElement("span");
      title.className = "scene-btn-title";
      title.textContent = scene.title;

      btn.appendChild(fill);
      btn.appendChild(title);
      // Jump to the scene's fully-entered state, not the blank frame at its start
      btn.addEventListener("click", function () { goToLabel(scene.id + "-shown"); });
      segmentsEl.appendChild(btn);

      segments.push({ id: scene.id, title: scene.title, start: start, end: end, btn: btn, fill: fill });
    });
  })();

  /* ----- UI sync (single render path for playing AND scrubbing) -------------------- */
  function syncUi() {
    var p = tl.progress();
    var t = tl.time();

    scrubInput.value = String(p);
    scrubInput.style.setProperty("--fill", (p * 100).toFixed(2) + "%");

    var currentTitle = "";
    segments.forEach(function (seg) {
      var frac = gsap.utils.clamp(0, 1, (t - seg.start) / (seg.end - seg.start));
      seg.fill.style.transform = "scaleX(" + frac + ")";
      var active = t >= seg.start && (t < seg.end || seg.end >= tl.duration());
      if (active) {
        seg.btn.setAttribute("aria-current", "true");
        currentTitle = seg.title;
      } else {
        seg.btn.removeAttribute("aria-current");
      }
    });

    scrubInput.setAttribute(
      "aria-valuetext",
      Math.round(p * 100) + "% — " + currentTitle
    );
  }

  /* ----- Wire up controls ------------------------------------------------------------ */
  playPauseBtn.addEventListener("click", togglePlay);
  introPlayBtn.addEventListener("click", play);

  scrubInput.addEventListener("input", function () {
    if (playing) { pause(); }
    killScrubTweens();
    var v = parseFloat(scrubInput.value) || 0;
    scrubTarget = v;
    tl.progress(v);
  });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) { return; }
    var interactive = e.target && e.target.closest
      ? e.target.closest("button, a, input, select, textarea")
      : null;

    if (e.code === "Space") {
      if (interactive) { return; } // let the focused control handle Space
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (interactive && interactive.matches("input, select, textarea")) { return; }
      e.preventDefault();
      jumpScene(e.key === "ArrowRight" ? 1 : -1);
    }
  });

  /* ----- Presentation speed ------------------------------------------------------------ */
  // GSAP's native timeScale multiplies the master timeline's playback rate
  // (1 = authored pace); it applies immediately, even mid-play. Scrubbing is
  // progress-based and unaffected, as it should be.
  var SPEED_KEY = "sous-presentation-speed";
  var speedBtns = document.querySelectorAll("#speedControl .speed-btn");

  function setSpeed(value) {
    tl.timeScale(value);
    speedBtns.forEach(function (btn) {
      btn.setAttribute("aria-pressed", String(parseFloat(btn.dataset.speed) === value));
    });
    try { sessionStorage.setItem(SPEED_KEY, String(value)); } catch (e) { /* fine */ }
  }

  speedBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setSpeed(parseFloat(btn.dataset.speed));
    });
  });

  try {
    var savedSpeed = parseFloat(sessionStorage.getItem(SPEED_KEY));
    if (savedSpeed >= 1 && savedSpeed <= 2) { setSpeed(savedSpeed); }
  } catch (e) { /* fine */ }

  /* ----- Survive page reloads at the same spot (per tab) ------------------------------ */
  // Hot-reload nicety: restore the playhead (paused) after a refresh so edits
  // don't reset the presentation to the start. sessionStorage is per-tab and
  // clears when the tab closes, so fresh visitors always start at 0.
  var PROGRESS_KEY = "sous-presentation-progress";
  try {
    var savedProgress = parseFloat(sessionStorage.getItem(PROGRESS_KEY));
    if (savedProgress > 0 && savedProgress <= 1) {
      tl.progress(savedProgress);
    }
    window.addEventListener("beforeunload", function () {
      sessionStorage.setItem(PROGRESS_KEY, String(tl.progress()));
    });
  } catch (e) {
    /* sessionStorage unavailable (privacy mode): reloads just start over */
  }

  /* ----- Initial state: paused on the title scene, scrubbable ------------------------- */
  enableScrub();
  syncUi();
})();
