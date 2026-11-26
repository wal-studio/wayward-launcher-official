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

  function gameSettings() {
    try {
      const root = JSON.parse(window.localStorage.getItem("tavern-settings") || "{}");
      return root && root.state && typeof root.state === "object" ? root.state : root;
    } catch (_) { return {}; }
  }

  function prefersLauncherLocal() {
    // The launcher mode switch is authoritative. Never honor a game-saved
    // Cloudflare Worker or arbitrary custom URL as a generation fallback.
    return runtimeStatus().ready;
  }

  function managedApiEndpoint(path, directNovelAi) {
    const raw = String(path || "").trim();
    if (!raw || raw.indexOf("\\") >= 0 || raw.indexOf("\0") >= 0) return null;
    try {
      const url = new URL(raw, LOCAL_ORIGIN + "/");
      if (url.pathname.startsWith("/api/")) return LOCAL_ORIGIN + url.pathname + url.search;
      if (!directNovelAi || url.search || url.hash) return null;
      const allowed = [
        "/ai/generate-image", "/ai/generate-image-stream", "/ai/augment-image", "/ai/upscale",
        "/oa/v1/images/generations"
      ];
      if (!allowed.includes(url.pathname)) return null;
      return LOCAL_ORIGIN + "/api/nai-compat" + url.pathname;
    } catch (_) { return null; }
  }

  function isAllowedDefaultCharacterCdnUrl(url, method, rawUrl) {
    if (!url || url.protocol !== "https:" || url.hostname.toLowerCase() !== "art.sintention.com"
        || url.port || url.username || url.password || url.search || url.hash
        || (method && method !== "GET" && method !== "HEAD")) return false;
    const raw = String(rawUrl || "");
    if (/%(?:00|2e|2f|5c|25)/i.test(raw)) return false;
    const parts = url.pathname.split("/");
    const legacy = parts.length >= 7 && parts[0] === "" && parts[1] === "images"
      && parts[2] === "illustrious" && parts[3] === "situation" && parts[4] === "info"
      && ["elena", "mara", "pippa"].includes(parts[5]);
    const modern = parts.length >= 6 && parts[0] === "" && parts[1] === "images"
      && parts[2] === "illustrious" && parts[3] === "characters";
    if (!legacy && !modern) return false;
    let decoded;
    try { decoded = parts.map(decodeURIComponent); } catch (_) { return false; }
    const character = legacy ? decoded[5] : (decoded[4] || "");
    if (modern && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(character)) return false;
    if (decoded.slice(1).some(segment => !segment || segment === "." || segment === ".."
        || segment.indexOf("/") >= 0 || segment.indexOf("\\") >= 0 || /[\u0000-\u001f\u007f]/.test(segment))) return false;
    const file = decoded[decoded.length - 1];
    return file.length <= 240 && /\.(?:png|jpe?g|webp|gif|avif)$/i.test(file);
  }

  function installGenerationFetchPolicy() {
    if (typeof window.fetch !== "function" || window.__waywardGenerationFetchPolicy) return;
    window.__waywardGenerationFetchPolicy = true;
    const previousFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      let request;
      let url;
      const rawInputUrl = typeof input === "string" ? input
        : input && typeof input.url === "string" ? input.url : "";
      try {
        request = new Request(input, init);
        url = new URL(request.url, window.location.href);
      } catch (_) { return previousFetch(input, init); }

      const savedBackend = String(gameSettings().imageBackendUrl || "").trim();
      let savedOrigin = "";
      try { savedOrigin = savedBackend ? new URL(savedBackend).origin : ""; } catch (_) {}
      const targetsSavedBackend = !!savedOrigin && url.origin === savedOrigin;
      const localApi = (url.origin === LOCAL_ORIGIN || url.origin === "http://localhost:8189")
        && url.pathname.startsWith("/api/");
      const knownImageApi = /^\/api\/(batch|generation|image|queue)(?:\/|$)/i.test(url.pathname);
      const directNovelAiGeneration = url.protocol === "https:"
        && url.hostname.toLowerCase() === "image.novelai.net"
        && request.method.toUpperCase() === "POST"
        && [
          "/ai/generate-image", "/ai/generate-image-stream", "/ai/augment-image", "/ai/upscale",
          "/oa/v1/images/generations"
        ].includes(url.pathname);

      // Preserve the allowlisted original CDN URL. MainActivity validates the
      // returned bytes and applies the SAF/ZIP fallback in shouldInterceptRequest.
      if (isAllowedDefaultCharacterCdnUrl(url, request.method, rawInputUrl || request.url)) {
        const cdnRequest = new Request(url.toString(), {
          method: request.method,
          headers: { Accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
          mode: "cors",
          credentials: "omit",
          cache: "default",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          signal: request.signal
        });
        return previousFetch(cdnRequest);
      }

      // Direct image fetches are routed through the same game-origin path as
      // <img> and CSS requests. OFF => local image pack; ON => generated cache.
      if (url.pathname.startsWith("/images/")) {
        const generatedPrefix = "/images/__wayward_generated__/";
        const relative = url.pathname.startsWith(generatedPrefix)
          ? url.pathname.slice(generatedPrefix.length)
          : url.pathname.slice("/images/".length);
        const serverReady = runtimeStatus().ready;
        // A URL from the launcher's local image server is a generated result, not a
        // PC/local image-pack asset. Keep its app-private cache reachable through the
        // HTTPS game-origin anchor even after the generation process is stopped.
        const fromLauncherImageServer = url.origin === LOCAL_ORIGIN
          || url.origin === "http://localhost:8189";
        const targetPath = serverReady || fromLauncherImageServer
          ? generatedPrefix + relative : "/images/" + relative;
        const targetUrl = new URL(targetPath + url.search, window.location.origin).toString();
        return previousFetch(new Request(targetUrl, request));
      }

      if (!targetsSavedBackend && !localApi && !knownImageApi && !directNovelAiGeneration) return previousFetch(input, init);

      const mapped = managedApiEndpoint(url.pathname + url.search, directNovelAiGeneration);
      if (!runtimeStatus().ready) {
        return Promise.resolve(new Response(JSON.stringify({
          error: "이미지 생성 서버가 꺼져 있습니다. 이미지팩 전용 모드에서는 외부 생성 주소를 호출하지 않습니다."
        }), { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }));
      }
      if (!mapped) {
        return Promise.resolve(new Response(JSON.stringify({
          error: "등록된 외부 이미지 생성 주소는 사용할 수 없습니다. 런처 관리 서버만 지원합니다."
        }), { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }));
      }
      const redirected = new Request(mapped, request);
      return previousFetch(redirected);
    };
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
    try {
      window.__WAYWARD_LAUNCHER_IMAGE_RUNTIME__ = Object.freeze({
        available: result.available,
        starting: result.starting,
        ready: result.ready,
        engine: result.engine,
        offlineOnly: !result.ready
      });
      window.__WW_STUDIO_OFFLINE_ONLY__ = !result.ready;
    } catch (_) {}
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
    let parsed;
    try { parsed = new URL(raw, window.location && window.location.href || LOCAL_ORIGIN + "/"); }
    catch (_) { return value; }
    if (isAllowedDefaultCharacterCdnUrl(parsed, "GET", raw)) return value;
    const path = parsed.pathname;
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

  function refreshBackendProbe(reason) {
    if (!backendProbe || !prefersLauncherLocal()) return Promise.resolve({ ok: false, reason: "probe_unavailable" });
    const state = runtimeStatus();
    if (!state.available && !state.starting) return Promise.resolve({ ok: false, retry: true, reason: "server_not_available" });
    if (probeRunning) {
      if (reason === "generation_settings_saved") {
        return probeRunning.then(
          () => refreshBackendProbe("generation_settings_saved_after_pending_probe"),
          () => refreshBackendProbe("generation_settings_saved_after_pending_probe")
        );
      }
      return probeRunning;
    }

    const options = { mode: "custom", url: LOCAL_ORIGIN, allowAutoProbe: false };

    probeRunning = Promise.resolve()
      .then(() => backendProbe(options, true))
      .then(result => {
        const connection = result && typeof result === "object" ? result : {};
        const ok = connection.baseUrl === LOCAL_ORIGIN || connection.baseUrl === "http://localhost:8189";
        report("studio_backend_probe_completed", {
          reason: String(reason || "runtime_state_changed"),
          available: state.available,
          ready: state.ready,
          connected: !!connection.baseUrl,
          selectedLocal: ok
        });
        return { ok, baseUrl: connection.baseUrl || null, comfyui: connection.comfyui === true };
      })
      .catch(error => {
        report("studio_backend_probe_failed", {
          reason: String(reason || "runtime_state_changed"),
          errorType: error && error.name ? String(error.name) : "Error"
        });
        return { ok: false, retry: true, reason: "backend_probe_failed" };
      })
      .finally(() => { probeRunning = null; });
    return probeRunning;
  }

  function registerBackendProbe(probe) {
    if (typeof probe !== "function") return;
    backendProbe = probe;
    report("studio_backend_probe_hooked", {});
    void refreshBackendProbe("probe_hooked");
  }

  function wrapLegacyApi(value) {
    if (!value) return value;
    let originalGet;
    try { originalGet = value.get; } catch (_) { return value; }
    if (typeof originalGet !== "function") return value;

    const wrappedGet = (name, ...args) => {
      const resolved = originalGet.apply(value, [name, ...args]);
      if (name !== "ph" || typeof resolved !== "function") return resolved;
      return (...callArgs) => {
        const current = resolved(...callArgs) || {};
        const state = runtimeStatus();
        return { ...current, baseUrl: LOCAL_ORIGIN, comfyui: state.ready, disabled: !state.ready };
      };
    };

    // Do not Proxy the WML API. Its get member can be a frozen, non-configurable
    // native function; returning wrappedGet from a Proxy get trap violates the
    // ECMAScript Proxy invariant and aborts Image Studio setup. A facade lets us
    // override get without mutating or proxying the original object.
    try {
      const facade = Object.create(value);
      const descriptor = Object.getOwnPropertyDescriptor(value, "get");
      Object.defineProperty(facade, "get", {
        configurable: true,
        enumerable: descriptor ? descriptor.enumerable : true,
        writable: true,
        value: wrappedGet
      });
      return facade;
    } catch (_) {
      // Preserve the original WML API if it cannot be safely facaded.
      return value;
    }
  }

  function installLegacyApiHook() {
    let current = null;
    try { current = window.__WML_LEGACY__ || null; } catch (_) {}
    try {
      Object.defineProperty(window, "__WML_LEGACY__", {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(value) { current = wrapLegacyApi(value); }
      });
      if (current) current = wrapLegacyApi(current);
    } catch (_) {
      if (current) current = wrapLegacyApi(current);
    }
  }

  function wrapSettingsStore(store) {
    if (!store || typeof store.getState !== "function") return store;
    try {
      const originalGetState = store.getState.bind(store);
      const facade = Object.create(store);
      Object.defineProperty(facade, "getState", {
        configurable: true,
        enumerable: true,
        writable: true,
        value() {
          const state = originalGetState();
          // The launcher's running engine is authoritative. Keep the persisted
          // game preference untouched while allowing this session to generate.
          const running = runtimeStatus().ready;
          if (!state) return { imageBackendMode: running ? "custom" : "off", imageBackendUrl: running ? LOCAL_ORIGIN : "" };
          return {
            ...state,
            imageBackendMode: running ? "custom" : "off",
            imageBackendUrl: running ? LOCAL_ORIGIN : ""
          };
        }
      });
      return facade;
    } catch (_) {
      return store;
    }
  }

  function wrapPauseSettingsFactory(factory) {
    if (!factory || typeof factory.connect !== "function" || factory.__waywardImageStudioWrapped) return factory;
    const originalConnect = factory.connect;
    try { Object.defineProperty(factory, "__waywardImageStudioWrapped", { value: true }); } catch (_) {}
    try {
      factory.connect = function(wmlApi, config, ...rest) {
        const api = originalConnect.call(this, wmlApi, config, ...rest);
        if (!config || config.id !== "imagestudio" || !api || typeof api.fn !== "function") return api;
        const originalFn = api.fn.bind(api);
        try {
          api.fn = function(name, ...args) {
            const value = originalFn(name, ...args);
            if (name === "settingsStore") return wrapSettingsStore(value);
            if (name === "imageBackendProbe" && typeof value === "function") {
              const managedProbe = (...probeArgs) => {
                const state = runtimeStatus();
                if (!state.available && !state.starting) {
                  return Promise.resolve({ baseUrl: null, comfyui: false, disabled: true });
                }
                return value({ mode: "custom", url: LOCAL_ORIGIN, allowAutoProbe: false }, true);
              };
              registerBackendProbe(managedProbe);
              return managedProbe;
            }
            if (name === "imageServerUrl" && typeof value === "function") {
              return path => localEndpoint(path) || managedApiEndpoint(path);
            }
            if (name === "imageBackend" && typeof value === "function") {
              return (...callArgs) => {
                const state = runtimeStatus();
                if (!state.ready) return { baseUrl: LOCAL_ORIGIN, comfyui: false, disabled: true };
                return { baseUrl: LOCAL_ORIGIN, comfyui: true, disabled: false };
              };
            }
            return value;
          };
        } catch (_) {
          report("studio_api_probe_wrapper_unavailable", {});
        }
        try {
          const probe = originalFn("imageBackendProbe");
          if (typeof probe === "function") registerBackendProbe(probe);
        } catch (_) {}
        return api;
      };
    } catch (_) {
      report("studio_factory_wrapper_unavailable", {});
    }
    return factory;
  }

  function installPauseSettingsFactoryHook() {
    let current = null;
    try { current = window.__waywardPauseSettingsUiFactory || null; } catch (_) {}
    try {
      Object.defineProperty(window, "__waywardPauseSettingsUiFactory", {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(value) { current = wrapPauseSettingsFactory(value); }
      });
      if (current) current = wrapPauseSettingsFactory(current);
    } catch (_) {
      if (current) wrapPauseSettingsFactory(current);
    }
  }

  function installStudioBridgeHook() {
    let current = null;
    try { current = window.WW_ImageStudioBridge || null; } catch (_) {}
    try {
      Object.defineProperty(window, "WW_ImageStudioBridge", {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(value) {
          current = value;
          if (!value || typeof value.connection !== "function" || value.__waywardLauncherConnectionWrapped) return;
          const originalConnection = value.connection.bind(value);
          value.connection = (...args) => {
            const state = runtimeStatus();
            return {
              baseUrl: LOCAL_ORIGIN,
              comfyui: state.ready,
              disabled: !state.ready
            };
          };
          try { Object.defineProperty(value, "__waywardLauncherConnectionWrapped", { value: true }); } catch (_) {}
          report("studio_connection_bridge_wrapped", {});
        }
      });
      if (current) {
        const setter = Object.getOwnPropertyDescriptor(window, "WW_ImageStudioBridge").set;
        setter.call(window, current);
      }
    } catch (_) {}
  }

  function installSettingsSaveProbe() {
    if (typeof window.fetch !== "function" || window.__waywardImageStudioFetchWrapped) return;
    window.__waywardImageStudioFetchWrapped = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      let isSettingsSave = false;
      try {
        const rawUrl = typeof input === "string" ? input : input && input.url;
        const url = new URL(String(rawUrl || ""), window.location.href);
        const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        isSettingsSave = method === "PUT" && url.pathname === "/api/generation/settings"
          && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8189";
      } catch (_) {}
      const request = nativeFetch(input, init);
      if (!isSettingsSave || !request || typeof request.then !== "function") return request;
      return request.then(response => {
        if (response && response.ok) {
          window.setTimeout(() => { void refreshBackendProbe("generation_settings_saved"); }, 150);
        }
        return response;
      });
    };
  }

  function serverOrigin() {
    if (!runtimeStatus().ready) return null;
    try {
      const connection = window.WW_ImageStudioBridge && window.WW_ImageStudioBridge.connection();
      const raw = connection && connection.baseUrl;
      const url = new URL(String(raw || ""));
      if (url.protocol !== "http:" ||
          (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
          url.port !== "8189" || (url.username || url.password)) return null;
      return url.origin;
    } catch (_) {
      const state = runtimeStatus();
      return prefersLauncherLocal() && (state.available || state.starting) ? LOCAL_ORIGIN : null;
    }
  }

  async function discoverNow() {
    if (discoveryBusy) return { ok: false, reason: "discovery_busy" };
    const bridge = window.WW_ImageStudioBridge;
    if (!bridge || typeof bridge.characters !== "function") {
      return { ok: false, retry: true, reason: "imagestudio_roster_not_ready" };
    }

    let roster;
    try { roster = bridge.characters(); }
    catch (_) { return { ok: false, retry: true, reason: "character_registry_unavailable" }; }
    const source = Array.isArray(roster && roster.characters) ? roster.characters : [];
    if (!source.length) return { ok: false, retry: true, reason: "character_registry_empty" };

    const characters = source.filter(character =>
      character &&
      /^[a-z0-9][a-z0-9_-]{0,99}$/.test(String(character.id || "").trim().toLowerCase()) &&
      String(character.id || "").trim().toLowerCase() !== "patron" &&
      String(character.originalPrompt || "").trim()
    ).map(character => ({
      id: String(character.id).trim().toLowerCase(),
      name: String(character.name || character.id).trim().slice(0, 100),
      prompt: String(character.prompt || "").trim(),
      negativePrompt: String(character.negativePrompt || "").trim(),
      originalPrompt: String(character.originalPrompt || "").trim(),
      originalNegativePrompt: String(character.originalNegativePrompt || "").trim()
    }));
    if (!characters.length) return { ok: true, found: source.length, added: 0, existing: 0, skipped: source.length };

    const origin = serverOrigin();
    if (!origin) return { ok: false, retry: true, reason: "image_server_connection_pending", found: characters.length };
    discoveryBusy = true;
    let added = 0;
    let existing = 0;
    try {
      for (let offset = 0; offset < characters.length; offset += 200) {
        const batch = characters.slice(offset, offset + 200);
        const response = await window.fetch(origin + "/api/generation/characters/discover-batch", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characters: batch })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.results) || body.results.length !== batch.length) {
          throw new Error("character_discovery_http_" + response.status);
        }
        for (const item of body.results) {
          if (item && item.added) added++;
          else existing++;
        }
      }
      discoveryComplete = true;
      discoveryResult = { ok: true, found: characters.length, added, existing, skipped: Number(roster.skipped) || 0 };
      report("studio_roster_discovery_completed", discoveryResult);
      return discoveryResult;
    } catch (error) {
      const result = { ok: false, retry: true, reason: String(error && (error.message || error)).slice(0, 100), found: characters.length, added, existing };
      report("studio_roster_discovery_retry", result);
      return result;
    } finally { discoveryBusy = false; }
  }

  let supportBadgeRefreshPending = false;
  let supportBadgeObserverInstalled = false;

  function normalizedSettingKey(raw) {
    return String(raw || "").trim()
      .replace(/^wwis[-_:]?/i, "")
      .replace(/^(?:generation|setting)[-_:]?/i, "")
      .replace(/[-_]+([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function settingPathPartsForControl(control) {
    return [
      control.getAttribute("name"),
      control.getAttribute("data-setting"),
      control.getAttribute("data-setting-key"),
      control.id
    ].flatMap(raw => String(raw || "").replace(/\[\d+\]/g, "").replace(/\[/g, ".").replace(/\]/g, ".").split(/[.:]/).filter(Boolean));
  }

  function settingKeysForControl(control) {
    return settingPathPartsForControl(control).map(normalizedSettingKey).filter(Boolean);
  }

  function supportLabelFor(control) {
    if (control.labels && control.labels.length) return control.labels[0];
    if (control.id) {
      for (const label of document.querySelectorAll("label[for]")) {
        if (label.htmlFor === control.id) return label;
      }
    }
    return control.closest("label") || control.parentElement;
  }

  function applySupportBadges(capabilities) {
    const unsupported = new Set(Array.isArray(capabilities && capabilities.unsupportedSettings)
      ? capabilities.unsupportedSettings : []);
    const missing = new Set(Array.isArray(capabilities && capabilities.missingResources)
      ? capabilities.missingResources : []);
    const badgeText = String(capabilities && capabilities.unsupportedLabel || "");
    const missingText = String(capabilities && capabilities.missingLabel || "PC에서 찾을 수 없음");
    if (!badgeText && !missingText) return;
    const controls = document.querySelectorAll("input,select,textarea,[data-setting]");
    for (const control of controls) {
      const keys = settingKeysForControl(control);
      const key = keys.find(value => unsupported.has(value));
      const label = supportLabelFor(control);
      if (!label || !label.appendChild) continue;
      const existing = label.querySelector && label.querySelector("[data-wayward-image-support-badge]");
      if (existing) existing.remove();
      if (!key) continue;
      const statusText = unsupported.has(key) ? badgeText : (missing.has(key) ? missingText : "");
      if (!statusText) continue;
      const badge = document.createElement("small");
      badge.setAttribute("data-wayward-image-support-badge", "true");
      badge.textContent = statusText;
      badge.style.cssText = "display:inline-block;margin-left:6px;font-size:10px;line-height:1.2;opacity:.68;font-weight:600;white-space:nowrap;";
      label.appendChild(badge);
    }
  }

  function resourceListForSetting(key) {
    const mapping = {
      checkpoint: "checkpoints", sdxlCheckpoint: "checkpoints",
      lora: "loras", sdxlLora: "loras", sdxlLoras: "loras",
      loras: "loras", animaLoras: "loras",
      model: "diffusionModels", animaModel: "diffusionModels",
      clip: "textEncoders", animaClip: "textEncoders",
      vae: "vaes", animaVae: "vaes",
      sampler: "samplers", sdxlSampler: "samplers",
      scheduler: "schedulers", sdxlScheduler: "schedulers"
    };
    return mapping[key] || "";
  }

  function applyRemoteResourceOptions(resources) {
    if (!resources || typeof resources !== "object") return;
    const remotePairedPc = resources.source === "paired-pc-comfyui";
    for (const control of document.querySelectorAll("input[type='text'][data-wayward-remote-model-root]")) {
      if (remotePairedPc) continue;
      const original = control.getAttribute("data-wayward-remote-original-value");
      const originalPlaceholder = control.getAttribute("data-wayward-remote-original-placeholder");
      const originalTitle = control.getAttribute("data-wayward-remote-original-title");
      const originalReadOnly = control.getAttribute("data-wayward-remote-original-readonly");
      if (original !== null) control.value = original;
      if (originalPlaceholder !== null) control.placeholder = originalPlaceholder;
      if (originalTitle !== null) control.title = originalTitle;
      control.readOnly = originalReadOnly === "true";
      control.removeAttribute("data-wayward-remote-model-root");
      control.removeAttribute("data-wayward-remote-original-value");
      control.removeAttribute("data-wayward-remote-original-placeholder");
      control.removeAttribute("data-wayward-remote-original-title");
      control.removeAttribute("data-wayward-remote-original-readonly");
      const row = control.closest("label")?.parentElement || control.parentElement;
      if (row && row.querySelectorAll) {
        for (const button of row.querySelectorAll("button[data-wayward-remote-model-picker]")) {
          button.disabled = button.getAttribute("data-wayward-remote-original-disabled") === "true";
          const originalTitle = button.getAttribute("data-wayward-remote-original-title");
          if (originalTitle !== null) button.title = originalTitle;
          button.removeAttribute("data-wayward-remote-model-picker");
          button.removeAttribute("data-wayward-remote-original-disabled");
          button.removeAttribute("data-wayward-remote-original-title");
        }
      }
    }
    if (remotePairedPc) {
      for (const control of document.querySelectorAll("input[type='text']")) {
        const keys = settingKeysForControl(control);
        if (!keys.some(key => key === "modelsDirectory" || key === "loraDirectory")) continue;
        if (!control.hasAttribute("data-wayward-remote-model-root")) {
          control.setAttribute("data-wayward-remote-original-value", control.value || "");
          control.setAttribute("data-wayward-remote-original-placeholder", control.placeholder || "");
          control.setAttribute("data-wayward-remote-original-title", control.title || "");
          control.setAttribute("data-wayward-remote-original-readonly", String(control.readOnly));
          control.setAttribute("data-wayward-remote-model-root", "true");
        }
        control.value = "PC 자동 탐색";
        control.placeholder = "PC 자동 탐색";
        control.readOnly = true;
        control.title = "페어링된 PC의 ComfyUI 모델 및 LoRA 폴더를 자동 탐색합니다.";
        const row = control.closest("label")?.parentElement || control.parentElement;
        if (row && row.querySelectorAll) {
          for (const button of row.querySelectorAll("button")) {
            if (/폴더|경로|찾기|browse|folder|select/i.test(String(button.textContent || "") + " " + String(button.title || ""))) {
              if (!button.hasAttribute("data-wayward-remote-model-picker")) {
                button.setAttribute("data-wayward-remote-original-disabled", String(button.disabled));
                button.setAttribute("data-wayward-remote-original-title", button.title || "");
                button.setAttribute("data-wayward-remote-model-picker", "true");
              }
              button.disabled = true;
              button.title = "페어링된 PC에서 자동 탐색합니다.";
            }
          }
        }
      }
    }
    for (const control of document.querySelectorAll("select,input[type='text']")) {
      const pathParts = settingPathPartsForControl(control);
      const normalizedParts = pathParts.map(normalizedSettingKey).filter(Boolean);
      const key = normalizedParts.find(value => resourceListForSetting(value));
      if (!key) continue;
      const nestedCharacterLora = pathParts.some(value => /^(?:animaLoras|sdxlLoras)$/i.test(value));
      if (nestedCharacterLora && !pathParts.some(value => value.toLowerCase() === "name")) continue;
      const listName = resourceListForSetting(key);
      const values = Array.isArray(resources[listName])
        ? resources[listName].filter(value => typeof value === "string" && value.trim()).map(value => value.trim())
        : [];
      if (!values.length) continue;

      if (control.tagName === "SELECT") {
        const selected = control.multiple
          ? Array.from(control.selectedOptions || []).map(option => option.value)
          : [control.value];
        const options = [];
        for (const value of values) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          option.selected = selected.includes(value);
          options.push(option);
        }
        for (const value of selected) {
          if (value && !values.includes(value)) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value + " (PC에서 찾을 수 없음)";
            option.selected = true;
            option.setAttribute("data-wayward-missing-resource", "true");
            options.unshift(option);
          }
        }
        control.replaceChildren(...options);
        if (!control.multiple && !selected[0] && values.length) control.value = values[0];
      } else {
        const id = "wayward-imagegen-resources-" + key;
        let datalist = document.getElementById(id);
        if (!datalist) {
          datalist = document.createElement("datalist");
          datalist.id = id;
          document.body.appendChild(datalist);
        }
        datalist.replaceChildren(...values.map(value => {
          const option = document.createElement("option");
          option.value = value;
          return option;
        }));
        control.setAttribute("list", id);
      }
    }
  }

  async function refreshSupportBadges() {
    const origin = serverOrigin();
    if (!origin) return;
    try {
      const response = await window.fetch(origin + "/api/generation/capabilities", {
        method: "GET", credentials: "omit", cache: "no-store"
      });
      if (!response.ok) return;
      const capabilities = await response.json();
      applySupportBadges(capabilities);
      if (capabilities && capabilities.provider === "comfy") {
        const resourcesResponse = await window.fetch(origin + "/api/generation/resources", {
          method: "GET", credentials: "omit", cache: "no-store"
        });
        if (resourcesResponse.ok) applyRemoteResourceOptions(await resourcesResponse.json());
      } else {
        applyRemoteResourceOptions({ source: "local-comfyui" });
      }
    } catch (_) {}
  }

  function installSupportBadgeObserver() {
    if (supportBadgeObserverInstalled || typeof MutationObserver !== "function") return;
    supportBadgeObserverInstalled = true;
    const observer = new MutationObserver(records => {
      const addedSettingsControls = records.some(record =>
        Array.from(record.addedNodes || []).some(node => node && node.nodeType === 1
          && (node.matches("input,select,textarea,label") || node.querySelector("input,select,textarea,label")))
      );
      if (!addedSettingsControls || supportBadgeRefreshPending) return;
      supportBadgeRefreshPending = true;
      window.setTimeout(() => {
        supportBadgeRefreshPending = false;
        void refreshSupportBadges();
      }, 180);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("change", event => {
      const target = event && event.target;
      if (target && target.matches && target.matches("input,select,textarea")) {
        window.setTimeout(() => { void refreshSupportBadges(); }, 120);
      }
    }, true);
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
        installSupportBadgeObserver();
        window.setTimeout(() => { void refreshSupportBadges(); }, 180);
        report("studio_settings_opened", {});
        return { ok: true };
      }
      await delay(100);
    }
    report("studio_settings_open_failed", { reason: "settings_button_timeout" });
    return { ok: false, reason: "settings_button_timeout" };
  }

  function watchManagedServer() {
    let attempts = 0;
    const check = () => {
      if (attempts++ >= 300) return;
      const state = runtimeStatus();
      const signature = [state.available, state.starting, state.ready, state.backendVersion].join(":");
      if (state.available && signature !== lastRuntimeSignature) {
        lastRuntimeSignature = signature;
        void refreshBackendProbe("managed_server_state_changed");
      }
      if (!state.ready || !backendProbe) window.setTimeout(check, 500);
    };
    window.setTimeout(check, 500);
  }

  installImageElementUrlRewrite();
  installGenerationFetchPolicy();
  installLegacyApiHook();
  installPauseSettingsFactoryHook();
  installStudioBridgeHook();
  installSettingsSaveProbe();

  window.WaywardLauncherImageStudio = Object.freeze({
    openGenerationSettings,
    discoverNow,
    refreshBackendProbe,
    getDiscoveryStatus: () => ({ complete: discoveryComplete, result: discoveryResult }),
    getRuntimeStatus: runtimeStatus
  });

  if (!window.__WAYWARD_IMAGE_STUDIO_TEST__) {
    let attempts = 0;
    const retry = async () => {
      if (discoveryComplete || attempts >= 90) return;
      attempts++;
      const result = await discoverNow();
      if (!result.ok || result.retry) window.setTimeout(retry, Math.min(5000, 500 + attempts * 100));
    };
    window.setTimeout(retry, 500);
    watchManagedServer();
  }
})();
