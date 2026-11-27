(() => {
  "use strict";
  if (window.__waywardImageStudioLauncherInstalled) return;
  window.__waywardImageStudioLauncherInstalled = true;

  const host = window.WMLHost;
  const LOCAL_ORIGIN = "http://127.0.0.1:8189";
  const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  let backendProbe = null;
  let probeRunning = null;
  let lastRuntimeSignature = "";
  let discoveryBusy = false;
  let discoveryComplete = false;
  let discoveryResult = null;

  function report(event, details) {
    try {
      if (host && typeof host.logImageProviderDiagnostic === "function") {
        host.logImageProviderDiagnostic(event, JSON.stringify(details || {}));
      }
    } catch (_) {}
  }

  function runtimeEngine(status) {
    const declared = String(status && status.engine || "").trim().toLowerCase();
    if (declared) return declared;
    const version = String(status && status.backendVersion || "");
    const parts = version.split(":");
    return parts[0] === "launcher-imagegen" && parts[2]
      ? parts[2].toLowerCase()
      : "unknown";
  }

  function runtimeStatus() {
    let status = null;
    try {
      if (host && typeof host.imageGenRuntimeStatus === "function") {
        const raw = host.imageGenRuntimeStatus();
        status = typeof raw === "string" ? JSON.parse(raw) : raw;
      }
    } catch (_) {}

    const result = {
      available: !!(status && status.available === true),
      starting: !!(status && status.starting === true),
      ready: !!(status && status.ready === true),
      backendVersion: String(status && status.backendVersion || ""),
      engine: runtimeEngine(status)
    };

    return result;
  }

  function localEndpoint(path) {
    // Cached generated images are served by the Native WebView interceptor; they do
    // not require the 8189 generation process to stay alive. API paths below still
    // require a running/starting managed server.
    const value = String(path || "").trim();
    if (!value || value.indexOf("\\") >= 0 || value.indexOf("\0") >= 0) return null;
    let url;
    try { url = new URL(value, LOCAL_ORIGIN + "/"); }
    catch (_) { return null; }
    if (url.username || url.password ||
        (url.origin !== LOCAL_ORIGIN && url.origin !== "http://localhost:8189")) return null;

    if (url.pathname.startsWith("/api/")) {
      const state = runtimeStatus();
      if (!state.available && !state.starting) return null;
      return LOCAL_ORIGIN + url.pathname + url.search;
    }
    // Cached image files live in app-private storage and remain readable even
    // when the generation service is stopped; only API requests need it alive.
    if (!url.pathname.startsWith("/images/")) return null;

    const encodedSegments = url.pathname.slice("/images/".length).split("/");
    if (!encodedSegments.length) return null;
    const segments = [];
    try {
      for (const encoded of encodedSegments) {
        const segment = decodeURIComponent(encoded);
        if (!segment || segment === "." || segment === ".." ||
            segment.indexOf("/") >= 0 || segment.indexOf("\\") >= 0 ||
            segment.indexOf("\0") >= 0) return null;
        segments.push(encodeURIComponent(segment));
      }
    } catch (_) { return null; }

    const gameOrigin = String(window.location && window.location.origin || "");
    try {
      const parsedGameOrigin = new URL(gameOrigin);
      if (parsedGameOrigin.protocol !== "https:" || parsedGameOrigin.origin !== gameOrigin) return null;
    } catch (_) { return null; }
    return gameOrigin + "/images/__wayward_generated__/" + segments.join("/") + url.search;
  }

  function imageElementSource(value) {
    const raw = String(value || "").trim();
    if (!raw) return value;
    let path = "";
    try { path = new URL(raw, window.location && window.location.href || LOCAL_ORIGIN + "/").pathname; }
    catch (_) { return value; }
    if (!path.startsWith("/images/")) return value;
    const mapped = localEndpoint(raw);
    if (!mapped || mapped === raw) return value;
    report("generated_image_url_rewritten", { path: path.slice(0, 200), targetOrigin: window.location.origin });
    return mapped;
  }

  function installImageElementUrlRewrite() {
    const prototype = window.HTMLImageElement && window.HTMLImageElement.prototype;
    if (!prototype || prototype.__waywardGeneratedImageUrlRewrite) {
      report("generated_image_dom_rewrite_unavailable", {});
      return;
    }
    try {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
      if (!descriptor || typeof descriptor.set !== "function" || typeof descriptor.get !== "function") {
        report("generated_image_src_descriptor_unavailable", {});
        return;
      }
      Object.defineProperty(prototype, "src", {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() { return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, imageElementSource(value)); }
      });
      const nativeSetAttribute = prototype.setAttribute || (window.Element && window.Element.prototype.setAttribute);
      if (typeof nativeSetAttribute === "function") {
        prototype.setAttribute = function(name, value) {
          const next = String(name || "").toLowerCase() === "src"
            ? imageElementSource(value) : value;
          return nativeSetAttribute.call(this, name, next);
        };
      }
      Object.defineProperty(prototype, "__waywardGeneratedImageUrlRewrite", { value: true });
      report("generated_image_dom_rewrite_installed", {});
    } catch (error) {
      report("generated_image_dom_rewrite_failed", {
        reason: String(error && (error.message || error)).slice(0, 160)
      });
    }
  }

  async function openGenerationSettings() {
    const studio = window.WW_ImageStudio;
    if (!studio || typeof studio.open !== "function") {
      report("studio_settings_open_failed", { reason: "imagestudio_not_loaded" });
      return { ok: false, reason: "imagestudio_not_loaded" };
    }
    try { studio.open(); }
    catch (_) {
      report("studio_settings_open_failed", { reason: "studio_open_threw" });
      return { ok: false, reason: "studio_open_failed" };
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const button = document.querySelector("#wwis-generation-settings");
      if (button && !button.disabled) {
        button.click();
        report("studio_settings_opened", {});
        return { ok: true };
      }
      await delay(100);
    }
    report("studio_settings_open_failed", { reason: "settings_button_timeout" });
    return { ok: false, reason: "settings_button_timeout" };
  }

  // The launcher must not rewrite generation URLs, settings, provider selection,
  // prompts, or Image Studio APIs. Keep only the generated-image display bridge.
  installImageElementUrlRewrite();

  window.WaywardLauncherImageStudio = Object.freeze({
    openGenerationSettings
  });
})();
