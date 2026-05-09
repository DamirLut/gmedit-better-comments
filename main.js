(function () {
  var editors = [];
  var sessions = [];
  var tags = [];
  var regions = [];
  var baseTagsRaw = [];
  var baseRegionsRaw = [];
  var inlineRegionColors = [];
  var styleEl = null;
  var stylePending = false;
  var Project = null;

  var PROJECT_CONFIG_PATH = ".gmedit/better-comments.json";

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

  function escapeRegex(text) {
    return String(text).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
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

  function normalizeRegions(rawRegions) {
    var out = [];
    var seen = {};

    if (!Array.isArray(rawRegions)) return out;

    for (var i = 0; i < rawRegions.length; i++) {
      var raw = rawRegions[i] || {};
      var name = String(raw.name || "").trim();
      var firstWord = name.split(/\s+/)[0];
      var slug = slugify(firstWord);

      if (!slug || !firstWord || seen[firstWord] || !isValidColor(raw.color)) {
        continue;
      }

      seen[firstWord] = true;
      out.push({
        name: firstWord,
        slug: slug,
        color: normalizeColor(raw.color),
      });
    }

    return out;
  }

  function getTagMergeKey(raw) {
    return slugify(raw && raw.name);
  }

  function getRegionMergeKey(raw) {
    var name = String((raw && raw.name) || "").trim();
    return name.split(/\s+/)[0];
  }

  function isValidTagEntry(raw) {
    return (
      !!getTagMergeKey(raw) &&
      !!String((raw && raw.match) || "").trim() &&
      isValidColor(raw && raw.color)
    );
  }

  function isValidRegionEntry(raw) {
    return !!getRegionMergeKey(raw) && isValidColor(raw && raw.color);
  }

  function mergeRawEntries(baseEntries, projectEntries, getKey, isValidEntry) {
    var base = Array.isArray(baseEntries) ? baseEntries : [];
    var project = Array.isArray(projectEntries) ? projectEntries : [];
    var validProject = [];
    var projectKeys = {};
    var out = [];

    for (var i = 0; i < project.length; i++) {
      if (!isValidEntry(project[i])) continue;
      var projectKey = getKey(project[i]);
      projectKeys[projectKey] = true;
      validProject.push(project[i]);
    }

    for (var j = 0; j < base.length; j++) {
      var baseKey = getKey(base[j]);
      if (!baseKey || !projectKeys[baseKey]) out.push(base[j]);
    }

    return out.concat(validProject);
  }

  function readProjectConfig() {
    var project = Project && Project.current;
    if (!project || !project.path || !project.existsSync) return null;

    try {
      if (!project.existsSync(PROJECT_CONFIG_PATH)) return null;
      return project.readJsonFileSync(PROJECT_CONFIG_PATH);
    } catch (error) {
      console.warn("better-comments: failed to read project config", error);
      return null;
    }
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

  function makeInlineRegionRule() {
    return {
      token: function (prefix, colorPart, label) {
        var colorMatch = /#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(colorPart);
        var slug = colorMatch ? "hex_" + colorMatch[1].toLowerCase() : "hex";

        return ["preproc.region", "regionname", "comment.better.region." + slug];
      },
      regex:
        "(#region\\b[ \\t]*)(\\[#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\][ \\t]*)(.*\\S.*$)",
      $betterComments: true,
    };
  }

  function makeConfiguredRegionRule(region) {
    return {
      token: ["preproc.region", "comment.better.region." + region.slug],
      regex: "(#region\\b[ \\t]*)(" + escapeRegex(region.name) + "\\b.*$)",
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

  function setRuleMeta(rules, key, value) {
    try {
      Object.defineProperty(rules, key, {
        value: value,
        writable: true,
        configurable: true,
      });
    } catch (error) {
      rules[key] = value;
    }
  }

  function clearRuleMeta(rules) {
    try {
      delete rules.$betterCommentsPatched;
      delete rules.$betterCommentsRulesByState;
    } catch (error) {
      rules.$betterCommentsPatched = false;
      rules.$betterCommentsRulesByState = undefined;
    }
  }

  function patchRules(rules) {
    if (!rules || rules.$betterCommentsPatched) return false;

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

    var startRules = rules.start;
    if (startRules) {
      var regionInserted = [];

      for (var j = regions.length - 1; j >= 0; j--) {
        var regionRule = makeConfiguredRegionRule(regions[j]);
        startRules.unshift(regionRule);
        regionInserted.push(regionRule);
      }

      var inlineRegionRule = makeInlineRegionRule();
      startRules.unshift(inlineRegionRule);
      regionInserted.push(inlineRegionRule);

      if (byState.start) {
        byState.start = byState.start.concat(regionInserted);
      } else {
        byState.start = regionInserted;
      }
    }

    setRuleMeta(rules, "$betterCommentsPatched", true);
    setRuleMeta(rules, "$betterCommentsRulesByState", byState);
    return true;
  }

  function unpatchRules(rules) {
    if (!rules) return false;

    if (!rules.$betterCommentsPatched) {
      clearRuleMeta(rules);
      return false;
    }

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

    clearRuleMeta(rules);
    return true;
  }

  function unpatchAllRules() {
    var seenRules = [];

    for (var i = 0; i < sessions.length; i++) {
      var session = sessions[i];
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
  }

  function updateEditorsFull() {
    for (var i = 0; i < editors.length; i++) {
      var editor = editors[i];
      if (editor.renderer && editor.renderer.updateFull) {
        editor.renderer.updateFull();
      }
    }
  }

  function refreshAllEditors() {
    for (var i = 0; i < editors.length; i++) {
      refreshEditor(editors[i]);
    }
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

  function getInlineRegionColors() {
    var seen = {};
    var colors = [];
    var rx = /^\s*#region\b[ \t]*\[(#(?:[0-9a-f]{3}|[0-9a-f]{6}))\]/i;

    for (var i = 0; i < sessions.length; i++) {
      var session = sessions[i];
      if (!session || !session.getLength || !session.getLine) continue;

      for (var row = 0; row < session.getLength(); row++) {
        var match = rx.exec(session.getLine(row));
        if (!match) continue;

        var color = normalizeColor(match[1]);
        var slug = "hex_" + color.substring(1).toLowerCase();

        if (seen[slug]) continue;
        seen[slug] = true;
        colors.push({
          slug: slug,
          color: color,
        });
      }
    }

    return colors;
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

    for (var j = 0; j < regions.length; j++) {
      var region = regions[j];
      css.push(`#app .ace-tm .ace_better.ace_region.ace_${region.slug} {
  color: ${region.color};
  background-color: ${hexToRgba(region.color, 0.14)};
  font-weight: 700;
}`);
    }

    for (var k = 0; k < inlineRegionColors.length; k++) {
      var inlineRegion = inlineRegionColors[k];
      css.push(`#app .ace-tm .ace_better.ace_region.ace_${inlineRegion.slug} {
  color: ${inlineRegion.color};
  background-color: ${hexToRgba(inlineRegion.color, 0.14)};
  font-weight: 700;
}`);
    }

    return css.join("\n\n");
  }

  function injectStyle() {
    removeStyle();

    if (tags.length == 0 && regions.length == 0 && inlineRegionColors.length == 0)
      return;

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

  function scheduleStyleRefresh() {
    if (stylePending) return;

    stylePending = true;
    setTimeout(function () {
      stylePending = false;
      inlineRegionColors = getInlineRegionColors();
      injectStyle();
    }, 50);
  }

  function refreshEditor(editor) {
    if (!editor || !editor.session) return;

    var session = editor.session;
    trackSession(session);
    scheduleStyleRefresh();

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
    var onChange = function () {
      scheduleStyleRefresh();
    };

    editor.$betterCommentsHandlers = {
      changeSession: onChangeSession,
      change: onChange,
    };

    editor.on("changeSession", onChangeSession);
    editor.on("change", onChange);
    editors.push(editor);
    refreshEditor(editor);
  }

  function onEditorCreated(e) {
    patchEditor(e.editor);
  }

  function applyConfig(projectConfig) {
    projectConfig = projectConfig || {};
    var mergedTags = mergeRawEntries(
      baseTagsRaw,
      projectConfig.tags,
      getTagMergeKey,
      isValidTagEntry
    );
    var mergedRegions = mergeRawEntries(
      baseRegionsRaw,
      projectConfig.regions,
      getRegionMergeKey,
      isValidRegionEntry
    );

    unpatchAllRules();

    tags = normalizeTags(mergedTags);
    regions = normalizeRegions(mergedRegions);
    inlineRegionColors = getInlineRegionColors();
    injectStyle();

    refreshAllEditors();
    updateEditorsFull();
  }

  function reloadConfig() {
    applyConfig(readProjectConfig());
  }

  function onProjectOpen() {
    reloadConfig();
  }

  function onProjectClose() {
    applyConfig(null);
  }

  function isProjectConfigFile(file) {
    if (!file || !file.path || !Project || !Project.current) return false;

    var project = Project.current;
    var relPath = project.relPath ? project.relPath(file.path) : file.path;
    relPath = String(relPath || "").replace(/\\/g, "/");

    return relPath == PROJECT_CONFIG_PATH;
  }

  function onFileSaveOrReload(e) {
    if (e && isProjectConfigFile(e.file)) {
      reloadConfig();
    }
  }

  function init(state) {
    var config = state && state.config ? state.config : {};
    var betterComments = config.betterComments || {};
    Project = $gmedit["gml.Project"];

    baseTagsRaw = Array.isArray(betterComments.tags) ? betterComments.tags : [];
    baseRegionsRaw = Array.isArray(betterComments.regions)
      ? betterComments.regions
      : [];

    patchEditor(window.aceEditor);
    GMEdit.on("editorCreated", onEditorCreated);
    GMEdit.on("projectOpen", onProjectOpen);
    GMEdit.on("projectClose", onProjectClose);
    GMEdit.on("fileSave", onFileSaveOrReload);
    GMEdit.on("fileReload", onFileSaveOrReload);

    reloadConfig();
  }

  function cleanup() {
    GMEdit.off("editorCreated", onEditorCreated);
    GMEdit.off("projectOpen", onProjectOpen);
    GMEdit.off("projectClose", onProjectClose);
    GMEdit.off("fileSave", onFileSaveOrReload);
    GMEdit.off("fileReload", onFileSaveOrReload);
    removeStyle();

    for (var i = 0; i < editors.length; i++) {
      var editor = editors[i];
      var handlers = editor.$betterCommentsHandlers;

      if (handlers) {
        editor.off("changeSession", handlers.changeSession);
        editor.off("change", handlers.change);
      }

      editor.$betterCommentsHandlers = null;
      editor.$betterCommentsPatched = false;
    }

    unpatchAllRules();
    updateEditorsFull();

    editors = [];
    sessions = [];
    tags = [];
    regions = [];
    baseTagsRaw = [];
    baseRegionsRaw = [];
    inlineRegionColors = [];
    stylePending = false;
    Project = null;
  }

  GMEdit.register("better-comments", {
    init,
    cleanup,
  });
})();
