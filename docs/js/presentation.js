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

  /* ----- Scenes (order = presentation order; ids match data-scene attrs) ---- */
  var SCENES = [
    { id: "intro", title: "Intro", hold: 2.4 },
    { id: "features", title: "Core Systems", hold: 3.6 },
    { id: "aggregator", title: "Aggregator", hold: 5 },
    { id: "templates", title: "Templates", hold: 2 }, // callout sequence supplies most of the dwell time
    { id: "what", title: "What is Sous", hold: 3.4 },
    { id: "problems", title: "The Problems", hold: 4.2 },
    { id: "how", title: "How It Works", hold: 4.2 },
    { id: "non-goals", title: "Non-Goals", hold: 3.6 },
    { id: "outro", title: "Get Started", hold: 1.2 }
  ];

  function sceneEl(id) {
    return stage.querySelector('[data-scene="' + id + '"]');
  }

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
      t.to({}, { duration: 1.8 }); // dwell while the viewer reads the tooltip
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
    t.to({}, { duration: 0.8 }); // beat to take in the template
    t.add(calloutsTimeline(tplPane));
    t.to(tplPane, { autoAlpha: 0, duration: 0.45, ease: "power2.in" });
    t.fromTo(
      outPane,
      { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", immediateRender: false }
    );
    t.to({}, { duration: 0.8 }); // beat to take in the output
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
      tl.to({}, { duration: 0.15 }); // brief gap between scenes
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
