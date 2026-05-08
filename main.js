(function () {
  var editors = [];
  var sessions = [];
  var tags = [];
  var styleEl = null;

  var STATE_PATCHES = {
    start: "start",
    "gml.comment.line": "line",
    "gml.comment.doc.line": "line",
    "gml.comment": "block",
    "gml.comment.doc": "block",
  };

  function token(slug) {
    return "comment.better." + slug;
  }

  function slugify(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function isValidColor(color) {
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(color || ""));
  }

  function normalizeColor(color) {
    color = String(color || "").toUpperCase();
    if (color.length == 4) {
      return (
        "#" +
        color.charAt(1) +
        color.charAt(1) +
        color.charAt(2) +
        color.charAt(2) +
        color.charAt(3) +
        color.charAt(3)
      );
    }
    return color;
  }

  function hexToRgba(color, alpha) {
    color = normalizeColor(color);
    var r = parseInt(color.substr(1, 2), 16);
    var g = parseInt(color.substr(3, 2), 16);
    var b = parseInt(color.substr(5, 2), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  function normalizeTags(rawTags) {
    var out = [];
    var colorsBySlug = {};

    if (!Array.isArray(rawTags)) return out;

    for (var i = 0; i < rawTags.length; i++) {
      var raw = rawTags[i] || {};
      var name = String(raw.name || "").trim();
      var match = String(raw.match || "").trim();
      var slug = slugify(name);

      if (!slug || !match || !isValidColor(raw.color)) continue;

      var color = normalizeColor(raw.color);
      if (!colorsBySlug[slug]) colorsBySlug[slug] = color;

      out.push({
        name: name,
        slug: slug,
        match: match,
        color: colorsBySlug[slug],
        leadingOnly: raw.leadingOnly === true,
      });
    }

    return out;
  }

  function makeRule(tag, kind) {
    var tagToken = token(tag.slug);

    if (kind == "start") {
      return {
        token: ["comment", tagToken, tagToken],
        regex: "(\\/\\/\\/?\\s*)(" + tag.match + ")(.*$)",
        $betterComments: true,
      };
    }

    if (tag.leadingOnly) {
      return null;
    }

    if (kind == "block") {
      return {
        token: ["comment", tagToken, tagToken],
        regex: "(\\s*)(" + tag.match + ")(.*?)(?=\\*\\/|$)",
        $betterComments: true,
      };
    }

    return {
      token: ["comment", tagToken, tagToken],
      regex: "(\\s*)(" + tag.match + ")(.*$)",
      $betterComments: true,
    };
  }

  function getRuleInfo(session) {
    if (!session) return null;

    var mode = null;
    if (session.getMode) mode = session.getMode();
    if (!mode) mode = session.$mode;
    if (!mode) return null;

    if (!mode.$highlightRules && mode.getTokenizer) {
      mode.getTokenizer();
    }

    var highlightRules = mode.$highlightRules || mode.HighlightRules;
    if (!highlightRules) return null;

    var rules = highlightRules.$rules || highlightRules.rules || null;
    if (!rules) return null;

    return {
      mode: mode,
      rules: rules,
    };
  }

  function reloadTokenizer(session, info) {
    if (!session || !info || !info.mode || !session.bgTokenizer) return;

    info.mode.$tokenizer = null;
    if (info.mode.getTokenizer && session.bgTokenizer.setTokenizer) {
      session.bgTokenizer.setTokenizer(info.mode.getTokenizer());
    }

    session.bgTokenizer.start(0);
  }

  function patchRules(rules) {
    if (!rules || rules.$betterCommentsPatched || tags.length == 0)
      return false;

    var byState = {};

    for (var stateName in STATE_PATCHES) {
      var stateRules = rules[stateName];
      if (!stateRules) continue;

      var inserted = [];
      var kind = STATE_PATCHES[stateName];

      for (var i = tags.length - 1; i >= 0; i--) {
        var rule = makeRule(tags[i], kind);
        if (!rule) continue;
        stateRules.unshift(rule);
        inserted.push(rule);
      }

      byState[stateName] = inserted;
    }

    rules.$betterCommentsPatched = true;
    rules.$betterCommentsRulesByState = byState;
    return true;
  }

  function unpatchRules(rules) {
    if (!rules || !rules.$betterCommentsPatched) return false;

    var byState = rules.$betterCommentsRulesByState || {};

    for (var stateName in byState) {
      var stateRules = rules[stateName];
      var inserted = byState[stateName];
      if (!stateRules || !inserted) continue;

      for (var i = stateRules.length - 1; i >= 0; i--) {
        if (inserted.indexOf(stateRules[i]) >= 0) {
          stateRules.splice(i, 1);
        }
      }
    }

    rules.$betterCommentsPatched = false;
    rules.$betterCommentsRulesByState = null;
    return true;
  }

  function getUniqueTagsBySlug() {
    var seen = {};
    var unique = [];

    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (seen[tag.slug]) continue;
      seen[tag.slug] = true;
      unique.push(tag);
    }

    return unique;
  }

  function buildCss() {
    var css = [];
    var unique = getUniqueTagsBySlug();

    for (var i = 0; i < unique.length; i++) {
      var tag = unique[i];
      var style = `#app .ace-tm .ace_comment.ace_better.ace_${tag.slug} {
  color: ${tag.color};
  background-color: ${hexToRgba(tag.color, 0.14)};
  font-weight: 700;
}`;
      css.push(style);
    }

    return css.join("\n\n");
  }

  function injectStyle() {
    removeStyle();

    if (tags.length == 0) return;

    styleEl = document.createElement("style");
    styleEl.setAttribute("data-better-comments", "true");
    styleEl.textContent = buildCss();
    document.head.appendChild(styleEl);
  }

  function removeStyle() {
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }

    styleEl = null;
  }

  function trackSession(session) {
    if (session && sessions.indexOf(session) < 0) sessions.push(session);
  }

  function refreshEditor(editor) {
    if (!editor || !editor.session) return;

    var session = editor.session;
    trackSession(session);

    var info = getRuleInfo(session);
    if (info && patchRules(info.rules)) {
      reloadTokenizer(session, info);
    }

    if (editor.renderer && editor.renderer.updateFull) {
      editor.renderer.updateFull();
    }
  }

  function patchEditor(editor) {
    if (!editor || editor.$betterCommentsPatched) return;

    editor.$betterCommentsPatched = true;

    var onChangeSession = function () {
      refreshEditor(editor);
    };

    editor.$betterCommentsHandlers = {
      changeSession: onChangeSession,
    };

    editor.on("changeSession", onChangeSession);
    editors.push(editor);
    refreshEditor(editor);
  }

  function onEditorCreated(e) {
    patchEditor(e.editor);
  }

  function init(state) {
    var config = state && state.config ? state.config : {};
    var betterComments = config.betterComments || {};

    tags = normalizeTags(betterComments.tags);
    injectStyle();

    patchEditor(window.aceEditor);
    GMEdit.on("editorCreated", onEditorCreated);
  }

  function cleanup() {
    GMEdit.off("editorCreated", onEditorCreated);
    removeStyle();

    for (var i = 0; i < editors.length; i++) {
      var editor = editors[i];
      var handlers = editor.$betterCommentsHandlers;

      if (handlers) {
        editor.off("changeSession", handlers.changeSession);
      }

      editor.$betterCommentsHandlers = null;
      editor.$betterCommentsPatched = false;
    }

    var seenRules = [];
    for (var j = 0; j < sessions.length; j++) {
      var session = sessions[j];
      var info = getRuleInfo(session);
      var rules = info ? info.rules : null;

      if (rules && seenRules.indexOf(rules) < 0) {
        seenRules.push(rules);
        unpatchRules(rules);
      }

      if (info) {
        reloadTokenizer(session, info);
      }
    }

    for (var k = 0; k < editors.length; k++) {
      var current = editors[k];
      if (current.renderer && current.renderer.updateFull) {
        current.renderer.updateFull();
      }
    }

    editors = [];
    sessions = [];
    tags = [];
  }

  GMEdit.register("better-comments", {
    init,
    cleanup,
  });
})();
