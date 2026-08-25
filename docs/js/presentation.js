/* ==========================================================================
   Sous; landing-page presentation
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

  if (!window.gsap || !window.Observer || !window.TextPlugin) {
    // CDN failed: leave the static title scene visible, hide the player chrome.
    document.documentElement.classList.add("no-gsap");
    return;
  }

  gsap.registerPlugin(Observer, TextPlugin);

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
     base .scene CSS starts every section at opacity 0 / visibility hidden).

     Holds are COMPUTED from each scene's text via computeStepDelay() (a
     reading-speed model; see the pacing constants below). An explicit
     `hold` (seconds) on an entry is a rarely-used trump card that bypasses
     the computation. */
  // Titles are group-relative: the chapter bar shows GROUPS on its top row
  // and the active group's scenes on the bottom row.
  function problemScenes(key, groupTitle) {
    return [
      { id: key + "-statement", group: groupTitle, title: "Statement" },
      { id: key + "-status-quo", group: groupTitle, title: "Today" },
      { id: key + "-mitigation", group: groupTitle, title: "Sous" },
      { id: key + "-example", group: groupTitle, title: "Demo" },
      { id: key + "-alternatives", group: groupTitle, title: "Alts" }
    ];
  }

  // Problem #1 breaks convention with an extra Followup slide after its
  // status-quo (an opt-in sixth type; not every problem gets one).
  var teamsScenes = problemScenes("teams", "Reusability");
  teamsScenes.splice(2, 0, { id: "teams-followup", group: teamsScenes[0].group, title: "Followup" });

  var SCENES = [
    { id: "intro", group: "Intro", title: "Title", hold: 4.8 }, // play() skips past it; keep the timeline lean
    { id: "features", group: "Intro", title: "The Idea" },
    { id: "configs", group: "Intro", title: "Configs", hold: 2.6 }, // the reveal/spotlight sequence supplies most of the dwell time
    { id: "great-skill", group: "Intro", title: "Skills", hold: 3 }, // the callout sequence supplies most of the dwell time
    { id: "skill-followup", group: "Intro", title: "The Catch", hold: 3 }, // typer + callouts supply the dwell time
    { id: "aggregator", group: "Intro", title: "Aggregator" },
    { id: "templates", group: "Intro", title: "Templates", hold: 4 }, // callout sequence supplies most of the dwell time
    { id: "why", group: "Intro", title: "Why?" }
  ].concat(
    teamsScenes,
    problemScenes("tokens", "Tokens"),
    problemScenes("stale", "Stale"),
    problemScenes("speed", "Speed"),
    problemScenes("docs", "Docs"),
    [
      { id: "philosophy-augment", group: "Philosophy", title: "Augment" },
      { id: "philosophy-collective", group: "Philosophy", title: "The Gaps" },
      { id: "philosophy-unopinionated", group: "Philosophy", title: "No Opinions" },
      { id: "philosophy-enter", group: "Philosophy", title: "Easy In" },
      { id: "philosophy-exit", group: "Philosophy", title: "Easy Out" },
      { id: "outro", group: "End", title: "Get Started", hold: 2.4 } // end card; onComplete leaves it on screen anyway
    ]
  );

  /* ----- Pacing (the calibration knobs) ---------------------------------------
     A "token" is a word, weighted by length: ceil(letters / 5). So "variables"
     counts ~2, "and" counts 1 (the chars-per-5 standard behind WPM math).
     Delays are for 1x; the speed control's timeScale handles the rest. */
  var baseDelay = 200;            // THE pacing knob; everything below scales from it
  var perTokenDelay = baseDelay;                 // ms per prose token
  var perDiagramTokenDelay = baseDelay * 1.75;   // ms per diagram-label token (labels ~ structure)
  var minStepDelay = baseDelay * 25;             // floor: no scene flashes past
  var calloutBaseDelay = baseDelay * 15.625;     // ms per callout for eye travel + code cross-reference

  function countTokens(text) {
    var n = 0;
    String(text || "").trim().split(/\s+/).forEach(function (word) {
      if (word) { n += Math.ceil(word.length / 5); }
    });
    return n;
  }

  // A scene's 1x hold in ms: prose tokens at the prose rate, diagram-label
  // tokens at the (slower) diagram rate. Tooltip text is excluded; callouts
  // carry their own dwell. Uses textContent (scenes are hidden at init;
  // innerText is layout-dependent).
  function computeStepDelay(element) {
    var svgTokens = 0;
    element.querySelectorAll("svg").forEach(function (svg) {
      svgTokens += countTokens(svg.textContent);
    });
    var tipTokens = 0;
    element.querySelectorAll(".hl-tip").forEach(function (tip) {
      tipTokens += countTokens(tip.textContent);
    });
    var proseTokens = Math.max(0, countTokens(element.textContent) - svgTokens - tipTokens);
    return Math.max(minStepDelay, proseTokens * perTokenDelay + svgTokens * perDiagramTokenDelay);
  }

  function sceneEl(id) {
    return stage.querySelector('[data-scene="' + id + '"]');
  }

  /* ----- Problem-slide kickers (generated; single source of truth) -----------
     Every problem slide's heading is `(pill) Problem #<x>: <brief>`. It is
     built here, from this table, so its format can be changed in ONE place.
     Scene ids follow `<problem>-<slide-type>`. */
  var PROBLEMS = {
    teams: { num: 1, brief: "Configs Don't Travel" },
    tokens: { num: 2, brief: "Context Is Expensive" },
    stale: { num: 3, brief: "Hand-Written Lists Rot" },
    speed: { num: 4, brief: "Sessions Crawl" },
    docs: { num: 5, brief: "Scattered Docs Drift Apart" }
  };

  var SLIDE_TYPE_LABELS = {
    "statement": "Statement",
    "followup": "Followup",
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
  var scrubTarget = 0;

  /* ----- Master timeline ----------------------------------------------------- */
  // Pre-hide everything GSAP will reveal (the intro scene starts visible).
  SCENES.forEach(function (scene) {
    var el = sceneEl(scene.id);
    if (scene.id !== "intro") {
      gsap.set(el, { autoAlpha: 0 });
      gsap.set(el.querySelectorAll(".anim"), { autoAlpha: 0, y: 24 });
    }
  });

  // Followup-scene elements that its choreography reveals late
  gsap.set(stage.querySelectorAll(".followup-reveal"), { autoAlpha: 0, y: 24 });
  gsap.set(stage.querySelectorAll(".type-cursor-2"), { autoAlpha: 0 });

  // Callout highlights/tooltips start hidden (CSS sets opacity: 0; this adds
  // visibility so autoAlpha tweens manage both). Output panes crossfade in
  // during their scene's sub-scene sequence.
  gsap.set(stage.querySelectorAll(".hl-bg, .hl-tip"), { autoAlpha: 0 });
  gsap.set(stage.querySelectorAll(".code-pane-output"), { autoAlpha: 0 });

  /* ----- Sad/happy effects (the "commercial" treatment) -----------------------
     Status-quo slides get the SAD effect: the stage desaturates (--fx-gray
     drives a grayscale filter) and a "Without Sous" ribbon flies into the
     corner. Mitigation/example slides get the HAPPY effect: color returns, a
     blue "With Sous" ribbon flies in, and the ambient sky (orb + clouds)
     fades up. Everything runs inside the master timeline, so it scrubs.
     REMOVABLE AS A UNIT with the .fx-* markup and CSS. */
  var fxTint = stage.querySelector(".fx-sky-tint");
  var fxOrb = stage.querySelector(".fx-orb");
  var fxRain = stage.querySelector(".fx-rain");
  var fxGloom = stage.querySelector(".fx-gloom");
  var fxSadBanner = stage.querySelector(".fx-banner-sad");
  var fxHappyBanner = stage.querySelector(".fx-banner-happy");

  // Clouds fly in from whichever screen edge they sit closest to. Offscreen
  // offsets are MEASURED from the actual layout (the wrappers are positioned
  // in percentages, so fixed pixel offsets strand clouds on wide viewports).
  function cloudOffscreenX(el, side) {
    var margin = 120; // cushion so growth from a mid-session resize stays hidden
    if (side === "left") {
      return -(el.offsetLeft + el.offsetWidth + margin);
    }
    return stage.offsetWidth - el.offsetLeft + margin;
  }

  var FX_CLOUDS = [
    { el: stage.querySelector(".fx-cloud-wrap-1"), side: "left" },
    { el: stage.querySelector(".fx-cloud-wrap-2"), side: "right" },
    { el: stage.querySelector(".fx-cloud-wrap-3"), side: "left" }
  ];
  FX_CLOUDS.forEach(function (c) { c.fromX = cloudOffscreenX(c.el, c.side); });
  // The orb enters from the lower right and arcs up-and-left into place
  var FX_ORB_FROM = { x: 460, y: 340 };

  gsap.set([fxSadBanner, fxHappyBanner], { rotation: -45, x: 240, y: 240, autoAlpha: 0 });
  gsap.set([fxTint, fxRain, fxGloom], { autoAlpha: 0 });
  gsap.set(fxOrb, { x: FX_ORB_FROM.x, y: FX_ORB_FROM.y, autoAlpha: 0 });
  FX_CLOUDS.forEach(function (c) { gsap.set(c.el, { x: c.fromX, autoAlpha: 0 }); });

  function effectFor(sceneId) {
    if (/-statement$|-status-quo$|-followup$/.test(sceneId)) { return "sad"; }
    if (/-mitigation$|-example$/.test(sceneId) || sceneId === "outro") { return "happy"; }
    return "none";
  }

  // Diagram dash march: one GSAP loop drives every dashed flow line (the CSS
  // stroke-dashoffset keyframe it replaces was paint-bound and froze on some
  // machines). 12 = one full dash period (6 on, 6 off), so the loop is
  // seamless. NOTE: this site deliberately IGNORES prefers-reduced-motion
  // (Luke's direction, 2026-08-14).
  gsap.fromTo(
    stage.querySelectorAll(".orbit-lines line, .flow-lines line"),
    { strokeDashoffset: 0 },
    { strokeDashoffset: -12, duration: 0.6, ease: "none", repeat: -1 }
  );

  // Rain drops: DOM elements tweened on transform only (compositor-safe).
  // syncUi pauses the loops while the rain container is invisible so hidden
  // rain costs nothing.
  var rainAmbient = null;
  (function buildRain() {
    var dropsBox = fxRain.querySelector(".fx-rain-drops");
    var fallDistance = stage.offsetHeight * 1.4;
    var drops = [];
    var t = gsap.timeline({ paused: true });
    for (var i = 0; i < 75; i++) {
      var far = i % 3 === 0;
      var drop = document.createElement("div");
      drop.className = "drop" + (far ? " drop-far" : "");
      drop.style.left = gsap.utils.random(0, 100) + "%";
      drop.style.opacity = String(gsap.utils.random(far ? 0.08 : 0.15, far ? 0.18 : 0.35));
      dropsBox.appendChild(drop);
      drops.push(drop);
      t.fromTo(drop,
        { y: 0, scaleY: gsap.utils.random(0.6, 1.3) },
        {
          y: fallDistance,
          duration: gsap.utils.random(far ? 1.7 : 0.9, far ? 2.6 : 1.5),
          ease: "none",
          repeat: -1
        }, 0);
    }
    // Randomize each drop's phase so the loop is mid-fall from frame one
    t.getChildren().forEach(function (tween) { tween.progress(Math.random()); });
    rainAmbient = t;
  })();

  function bannerIn(banner) {
    return gsap.fromTo(
      banner,
      { rotation: -45, x: 240, y: 240, autoAlpha: 0 },
      { rotation: -45, x: 0, y: 0, autoAlpha: 1, duration: 0.7, ease: "power3.out", immediateRender: false }
    );
  }

  function bannerOut(banner) {
    return gsap.to(banner, { x: 240, y: 240, autoAlpha: 0, duration: 0.5, ease: "power2.in" });
  }

  // Sky entrance: tint fades up, clouds fly in from their nearest edge, and
  // the orb rises along an arc (different eases on x and y bend the path:
  // y climbs fast then settles, x keeps gliding left; the reverse on exit).
  function skyIn(t, at) {
    t.to(fxTint, { autoAlpha: 1, duration: 1.2, ease: "power1.inOut" }, at);
    FX_CLOUDS.forEach(function (c, i) {
      t.fromTo(c.el, { x: c.fromX, autoAlpha: 0 },
        { x: 0, autoAlpha: 1, duration: 1.4, ease: "power2.out", immediateRender: false }, at + 0.1 + i * 0.15);
    });
    t.fromTo(fxOrb, { x: FX_ORB_FROM.x },
      { x: 0, duration: 1.6, ease: "power1.inOut", immediateRender: false }, at + 0.1);
    t.fromTo(fxOrb, { y: FX_ORB_FROM.y },
      { y: 0, duration: 1.6, ease: "power3.out", immediateRender: false }, at + 0.1);
    // The orb's working opacity is 0.55 (CSS base is 0 to prevent load flicker)
    t.fromTo(fxOrb, { autoAlpha: 0 },
      { autoAlpha: 0.55, duration: 1.0, immediateRender: false }, at + 0.1);
  }

  function skyOut(t, at) {
    t.to(fxTint, { autoAlpha: 0, duration: 0.6 }, at);
    FX_CLOUDS.forEach(function (c) {
      t.to(c.el, { x: c.fromX, autoAlpha: 0, duration: 0.8, ease: "power2.in" }, at);
    });
    t.to(fxOrb, { x: FX_ORB_FROM.x, duration: 0.9, ease: "power1.inOut" }, at);
    t.to(fxOrb, { y: FX_ORB_FROM.y, duration: 0.9, ease: "power3.in" }, at);
    t.to(fxOrb, { autoAlpha: 0, duration: 0.9 }, at);
  }

  function fxTransition(fx) {
    var t = gsap.timeline();
    if (fx === "sad") {
      t.to(stage, { "--fx-gray": 1, duration: 0.8, ease: "power2.inOut" }, 0);
      t.add(bannerOut(fxHappyBanner), 0);
      skyOut(t, 0);
      t.to([fxGloom, fxRain], { autoAlpha: 1, duration: 1.1, ease: "power1.inOut" }, 0.2);
      t.add(bannerIn(fxSadBanner), 0.15);
    } else if (fx === "happy") {
      t.to(stage, { "--fx-gray": 0, duration: 0.8, ease: "power2.inOut" }, 0);
      t.add(bannerOut(fxSadBanner), 0);
      t.to([fxGloom, fxRain], { autoAlpha: 0, duration: 0.5 }, 0);
      skyIn(t, 0.1);
      t.add(bannerIn(fxHappyBanner), 0.15);
    } else {
      t.to(stage, { "--fx-gray": 0, duration: 0.6, ease: "power2.inOut" }, 0);
      t.add(bannerOut(fxSadBanner), 0);
      t.add(bannerOut(fxHappyBanner), 0);
      t.to([fxGloom, fxRain], { autoAlpha: 0, duration: 0.5 }, 0);
      skyOut(t, 0);
    }
    return t;
  }

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
    t.to(el.querySelectorAll(".anim, .scene-exit"), {
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
      var tip = hl.querySelector(".hl-tip");
      // Dwell scales with the tooltip's text; the base covers eye travel and
      // reading the highlighted code itself.
      var dwell = (calloutBaseDelay + countTokens(tip ? tip.textContent : "") * perTokenDelay) / 1000;
      t.to(parts, { autoAlpha: 1, duration: 0.35 });
      t.to({}, { duration: dwell });
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

  // Followup scene: Matrix-style typer. Line 1 types, pause, line 2 types
  // (the blinking cursor hops lines), beat, then the code box and the
  // description below it rise in. TextPlugin tweens scrub like anything else.
  function followupTimeline(el) {
    var lines = el.querySelectorAll(".type-text");
    var cursor1 = el.querySelector(".type-cursor-1");
    var cursor2 = el.querySelector(".type-cursor-2");
    var reveals = el.querySelectorAll(".followup-reveal");
    var t = gsap.timeline();
    t.to(lines[0], { text: lines[0].getAttribute("data-type-text"), duration: 1.6, ease: "none" });
    t.to({}, { duration: 1.2 }); // pause on line 1
    t.set(cursor1, { autoAlpha: 0 });
    t.set(cursor2, { autoAlpha: 1 });
    t.to(lines[1], { text: lines[1].getAttribute("data-type-text"), duration: 2.2, ease: "none" });
    t.to({}, { duration: 0.9 }); // brief pause
    t.fromTo(reveals, { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.25, ease: "power2.out", immediateRender: false });
    return t;
  }

  // "What is a config?" scene: the grid sits for a beat, the two closing
  // lines rise in, then the Skills tile gets the spotlight (solid brand
  // green, slight grow) while everything else in the grid dims. Colors are
  // read from the tokens once at build time; both are theme-independent.
  function configsTimeline(el) {
    var reveals = el.querySelectorAll(".configs-reveal");
    var skills = el.querySelector(".config-item-skills");
    var rest = el.querySelectorAll(".config-item:not(.config-item-skills), .config-col-title");
    var css = getComputedStyle(document.documentElement);
    var t = gsap.timeline();
    t.to({}, { duration: 3.6 }); // sit with the grid
    t.fromTo(reveals[0], { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", immediateRender: false });
    t.to({}, { duration: 3.2 });
    t.fromTo(reveals[1], { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", immediateRender: false });
    t.to({}, { duration: 0.6 });
    t.to(rest, { opacity: 0.35, duration: 0.5, ease: "power1.inOut" });
    t.to(skills, {
      scale: 1.1,
      backgroundColor: css.getPropertyValue("--sous-primary").trim(),
      borderColor: css.getPropertyValue("--sous-brand-tertiary").trim(),
      color: css.getPropertyValue("--sous-white").trim(),
      duration: 0.5,
      ease: "back.out(2)"
    }, "<");
    return t;
  }

  // "A great skill" scene: time to read the title and lead and take in the
  // rendered skill, then the callouts in document order. Each code callout
  // carries a data-sync naming the lead word (data-quality) whose highlight
  // fades in and out WITH it; the closing line rises in after the last one.
  function greatSkillTimeline(el) {
    var reveal = el.querySelector(".skill-reveal");
    var t = gsap.timeline();
    t.to({}, { duration: 4.5 });
    el.querySelectorAll(".code-body .hl").forEach(function (hl) {
      var tip = hl.querySelector(".hl-tip");
      var parts = Array.prototype.slice.call(hl.querySelectorAll(".hl-bg, .hl-tip"));
      var sync = el.querySelector(
        '.great-skill-lead .hl[data-quality="' + hl.getAttribute("data-sync") + '"] .hl-bg'
      );
      if (sync) { parts.push(sync); }
      var dwell = (calloutBaseDelay + countTokens(tip ? tip.textContent : "") * perTokenDelay) / 1000;
      t.to(parts, { autoAlpha: 1, duration: 0.35 });
      t.to({}, { duration: dwell });
      t.to(parts, { autoAlpha: 0, duration: 0.35 });
    });
    t.to({}, { duration: 0.5 });
    t.fromTo(reveal, { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", immediateRender: false });
    return t;
  }

  // "The catch" scene: the line types out, the lead and the (familiar) skill
  // window rise in, then the same three highlights return carrying the
  // portability counterpoints.
  function skillFollowupTimeline(el) {
    var line = el.querySelector(".type-text");
    var reveals = el.querySelectorAll(".followup-reveal");
    var t = gsap.timeline();
    t.to(line, { text: line.getAttribute("data-type-text"), duration: 1.6, ease: "none" });
    t.to({}, { duration: 0.9 }); // beat on the typed line
    t.fromTo(reveals, { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.25, ease: "power2.out", immediateRender: false });
    t.to({}, { duration: 1.2 }); // re-orient on the familiar skill
    t.add(calloutsTimeline(el));
    return t;
  }

  // Optional per-scene timeline extensions, added after the scene has entered.
  var SCENE_EXTRAS = {
    configs: configsTimeline,
    "great-skill": greatSkillTimeline,
    "skill-followup": skillFollowupTimeline,
    templates: templatesTimeline,
    "teams-followup": followupTimeline
  };

  var tl = gsap.timeline({ paused: true, onUpdate: syncUi, onComplete: onEnded });

  var prevFx = "none";
  SCENES.forEach(function (scene, i) {
    var el = sceneEl(scene.id);
    var last = i === SCENES.length - 1;
    tl.addLabel(scene.id); // scene start: chapter-bar segment boundary
    if (scene.id !== "intro") {
      tl.add(sceneIn(el));
    }
    // Sad/happy effect transitions ride along with the scene entrance
    var fx = effectFor(scene.id);
    if (fx !== prevFx) {
      tl.add(fxTransition(fx), "<");
      prevFx = fx;
    }
    tl.addLabel(scene.id + "-shown"); // fully entered: the jump target
    if (SCENE_EXTRAS[scene.id]) {
      tl.add(SCENE_EXTRAS[scene.id](el));
    }
    // Explicit hold (seconds) trumps; otherwise pace by the scene's content
    var holdSec = scene.hold != null ? scene.hold : computeStepDelay(el) / 1000;
    tl.to({}, { duration: holdSec }); // hold the scene on screen
    if (!last) {
      tl.addLabel(scene.id + "-exit"); // hold over, exit animation begins
      tl.add(sceneOut(el));
      tl.to({}, { duration: 0.3 }); // brief gap between scenes
    }
  });

  /* ----- Player chrome reveal ---------------------------------------------------
     The title scene hides the bottom timeline and the speed control; they
     enter with the intro's exit (timeline bar slides up from below, speed
     control fades in). Timeline-driven, so scrubbing back re-hides them. */
  var playerControlsEl = document.querySelector(".player-controls");
  var speedControlEl = document.getElementById("speedControl");

  // autoAlpha rides along so the bar is hidden even if its measured height
  // drifts after the webfont loads (yPercent alone left a sliver visible)
  tl.fromTo(playerControlsEl, { yPercent: 100, autoAlpha: 0 },
    { yPercent: 0, autoAlpha: 1, duration: 0.6, ease: "power2.out", immediateRender: true },
    tl.labels["intro-exit"]);
  tl.fromTo(speedControlEl, { autoAlpha: 0 },
    { autoAlpha: 1, duration: 0.6, immediateRender: true },
    tl.labels["intro-exit"]);

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
      progressTo(scrubTarget);
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
    // presses play; skip the rest of its hold and transition away at once.
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

  /* ----- Chapter bar (two rows: groups on top, active group's scenes below) -------- */
  var groupsEl = document.getElementById("groupSegments");
  var timeElapsedEl = document.getElementById("timeElapsed");
  var timeRemainingEl = document.getElementById("timeRemaining");

  var GROUPS = [];       // { key, scenes, start, end }
  var sceneTimes = {};   // id -> { start, end }
  var groupRow = [];     // { group, btn, fill }
  var sceneRow = [];     // rebuilt whenever the active group changes
  var activeGroupKey = null;

  function makeSegmentButton(labelText, ariaLabel, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scene-btn";
    btn.setAttribute("aria-label", ariaLabel);
    var fill = document.createElement("span");
    fill.className = "scene-btn-fill";
    fill.setAttribute("aria-hidden", "true");
    var title = document.createElement("span");
    title.className = "scene-btn-title";
    title.textContent = labelText;
    btn.appendChild(fill);
    btn.appendChild(title);
    btn.addEventListener("click", onClick);
    return { btn: btn, fill: fill };
  }

  (function buildChapterBar() {
    var total = tl.duration();
    SCENES.forEach(function (scene, i) {
      sceneTimes[scene.id] = {
        start: tl.labels[scene.id],
        end: i < SCENES.length - 1 ? tl.labels[SCENES[i + 1].id] : total
      };
      var tail = GROUPS[GROUPS.length - 1];
      if (!tail || tail.key !== scene.group) {
        tail = { key: scene.group, scenes: [] };
        GROUPS.push(tail);
      }
      tail.scenes.push(scene);
    });
    GROUPS.forEach(function (g) {
      g.start = sceneTimes[g.scenes[0].id].start;
      g.end = sceneTimes[g.scenes[g.scenes.length - 1].id].end;
      var seg = makeSegmentButton(g.key, "Go to section: " + g.key, function () {
        goToLabel(g.scenes[0].id + "-shown");
      });
      groupsEl.appendChild(seg.btn); // equal widths (.scene-btn flex: 1 1 0)
      groupRow.push({ group: g, btn: seg.btn, fill: seg.fill });
    });
  })();

  function renderSceneRow(group) {
    segmentsEl.textContent = "";
    sceneRow = [];
    group.scenes.forEach(function (scene) {
      var times = sceneTimes[scene.id];
      // Jump to the scene's fully-entered state, not the blank frame at its start
      var seg = makeSegmentButton(scene.title, "Go to scene: " + group.key + ": " + scene.title, function () {
        goToLabel(scene.id + "-shown");
      });
      segmentsEl.appendChild(seg.btn); // equal widths (.scene-btn flex: 1 1 0)
      sceneRow.push({ scene: scene, start: times.start, end: times.end, btn: seg.btn, fill: seg.fill });
    });
  }

  function formatTime(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* ----- UI sync (single render path for playing AND scrubbing) -------------------- */
  function syncUi() {
    var p = tl.progress();
    var t = tl.time();
    var total = tl.duration();

    scrubInput.value = String(p);
    scrubInput.style.setProperty("--fill", (p * 100).toFixed(2) + "%");
    // Counters show wall-clock time at the current playback speed
    var speedScale = tl.timeScale() || 1;
    timeElapsedEl.textContent = formatTime(t / speedScale);
    timeRemainingEl.textContent = formatTime((total - t) / speedScale);

    var activeGroup = GROUPS[0];
    GROUPS.forEach(function (g) {
      if (t >= g.start - 0.001) { activeGroup = g; }
    });
    if (activeGroup.key !== activeGroupKey) {
      activeGroupKey = activeGroup.key;
      renderSceneRow(activeGroup);
    }

    groupRow.forEach(function (row) {
      var frac = gsap.utils.clamp(0, 1, (t - row.group.start) / (row.group.end - row.group.start));
      row.fill.style.transform = "scaleX(" + frac + ")";
      if (row.group === activeGroup) {
        row.btn.setAttribute("aria-current", "true");
      } else {
        row.btn.removeAttribute("aria-current");
      }
    });

    var currentTitle = activeGroup.key;
    sceneRow.forEach(function (seg) {
      var frac = gsap.utils.clamp(0, 1, (t - seg.start) / (seg.end - seg.start));
      seg.fill.style.transform = "scaleX(" + frac + ")";
      var active = t >= seg.start && (t < seg.end || seg.end >= total);
      if (active) {
        seg.btn.setAttribute("aria-current", "true");
        currentTitle = activeGroup.key + ": " + seg.scene.title;
      } else {
        seg.btn.removeAttribute("aria-current");
      }
    });

    scrubInput.setAttribute(
      "aria-valuetext",
      Math.round(p * 100) + "%, " + currentTitle
    );

    // Run the rain loops only while the rain layer is actually visible
    if (rainAmbient) {
      var rainVisible = gsap.getProperty(fxRain, "opacity") > 0.01;
      if (rainVisible && rainAmbient.paused()) {
        rainAmbient.play();
      } else if (!rainVisible && !rainAmbient.paused()) {
        rainAmbient.pause();
      }
    }
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
    syncUi(); // the time counters scale with speed; refresh them immediately
  }

  speedBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setSpeed(parseFloat(btn.dataset.speed));
    });
  });

  try {
    var savedSpeed = parseFloat(sessionStorage.getItem(SPEED_KEY));
    if (savedSpeed >= 0.5 && savedSpeed <= 2) { setSpeed(savedSpeed); }
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
