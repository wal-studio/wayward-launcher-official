import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../app/src/main/assets/imagegen-studio-bridge.js", import.meta.url), "utf8");
const outgoing = [];
const runtime = { available: false, starting: false, ready: false, backendVersion: "" };
const persisted = {
  imageBackendMode: "custom",
  imageBackendUrl: "https://my-worker.workers.dev/generate",
  keepOtherSetting: "preserved",
  sfwMode: true
};
const settingsStore = {
  getState() {
    return {
      ...persisted,
      set(partialOrUpdater) {
        const partial = typeof partialOrUpdater === "function"
          ? partialOrUpdater({ ...persisted }, { ...persisted })
          : partialOrUpdater;
        if (partial && typeof partial === "object" && !Array.isArray(partial)) Object.assign(persisted, partial);
        return partial;
      }
    };
  }
};
const events = [];
const backend = { baseUrl: "https://my-worker.workers.dev", comfyui: true };
const window = {
  __WAYWARD_IMAGE_STUDIO_TEST__: true,
  location: { href: "https://localhost:42000/game", origin: "https://localhost:42000" },
  setTimeout() { return 1; },
  clearTimeout() {},
  localStorage: {
    getItem(key) {
      return key === "tavern-settings" ? JSON.stringify({ state: persisted, version: 3 }) : null;
    }
  },
  WMLHost: {
    imageGenRuntimeStatus() { return JSON.stringify(runtime); },
    logImageProviderDiagnostic(name, details) { events.push({ name, details: JSON.parse(details) }); }
  },
  fetch(input, init) {
    outgoing.push({ input: typeof input === "string" ? input : input.url, init });
    return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  }
};
const context = {
  window, URL, Request, Response, Headers, Promise, Object, String, Boolean, Number,
  JSON, Error, WeakSet, Uint8Array, Math, Date, btoa, atob, setTimeout, clearTimeout
};
vm.runInNewContext(source, context, { filename: "imagegen-studio-bridge.js" });

const factory = {
  connect(_wmlApi, config) {
    assert.equal(config.id, "imagestudio");
    return {
      fn(name) {
        if (name === "settingsStore") return settingsStore;
        if (name === "imageBackendProbe") {
          return async (options, force) => {
            outgoing.push({ probe: true, options, force });
            return backend;
          };
        }
        if (name === "imageServerUrl") return path => "https://my-worker.workers.dev" + path;
        if (name === "imageBackend") return () => backend;
        return undefined;
      }
    };
  }
};
window.__waywardPauseSettingsUiFactory = factory;
const api = factory.connect({}, { id: "imagestudio" });

const stateFacade = api.fn("settingsStore").getState();
assert.equal(stateFacade.imageBackendMode, "off");
assert.equal(stateFacade.imageBackendUrl, "");
assert.equal(persisted.imageBackendMode, "custom", "read projection must not mutate persisted settings");
assert.equal(persisted.imageBackendUrl, "https://my-worker.workers.dev/generate");
assert.equal(stateFacade.keepOtherSetting, "preserved");
assert.equal(stateFacade.sfwMode, true);

stateFacade.set({
  imageBackendMode: "custom",
  imageBackendUrl: "https://attacker.example/generate",
  keepOtherSetting: "object-partial-preserved",
  sfwMode: false
});
assert.equal(persisted.imageBackendMode, "off", "server-off setter must force OFF");
assert.equal(persisted.imageBackendUrl, "", "server-off setter must clear the external URL");
assert.equal(persisted.keepOtherSetting, "object-partial-preserved");
assert.equal(persisted.sfwMode, false);

stateFacade.set(current => ({
  imageBackendMode: "custom",
  imageBackendUrl: "https://another.example/generate",
  keepOtherSetting: current.keepOtherSetting + "-updater"
}));
assert.equal(persisted.imageBackendMode, "off", "function updater must be guarded too");
assert.equal(persisted.imageBackendUrl, "");
assert.equal(persisted.keepOtherSetting, "object-partial-preserved-updater");
const beforeNoop = { ...persisted };
stateFacade.set(() => undefined);
assert.deepEqual(persisted, beforeNoop, "undefined updater result must pass through unchanged");

assert.equal(api.fn("imageBackendProbe")().then ? true : false, true);
const offProbe = await api.fn("imageBackendProbe")();
assert.equal(offProbe.disabled, true);
assert.equal(outgoing.some(item => item.probe), false,
  "server-off must not probe a saved Cloudflare Worker");
assert.equal(api.fn("imageBackend")().disabled, true);
assert.equal(api.fn("imageServerUrl")("/api/batch/enqueue"), "http://127.0.0.1:8189/api/batch/enqueue");

const packFetch = await window.fetch("https://art.sintention.com/images/portrait.png");
assert.equal(packFetch.status, 200);
assert.equal(outgoing.at(-1).input, "https://localhost:42000/images/portrait.png",
  "server-off image fetches must resolve through the local image-pack path");
const retainedGenerated = await window.fetch("http://127.0.0.1:8189/images/retained-result.png");
assert.equal(retainedGenerated.status, 200);
assert.equal(outgoing.at(-1).input,
  "https://localhost:42000/images/__wayward_generated__/retained-result.png",
  "cached generated images must retain their local image anchor");

const externalOff = await window.fetch("https://my-worker.workers.dev/generate", { method: "POST", body: "{}" });
assert.equal(externalOff.status, 200, "non-launcher hosts must remain ordinary fetches");
assert.equal(outgoing.at(-1).input, "https://my-worker.workers.dev/generate");
const directNaiOff = await window.fetch("https://image.novelai.net/ai/generate-image", { method: "POST", body: "{}" });
assert.equal(directNaiOff.status, 503, "direct NovelAI generation must not bypass the ImageGen job runner");
assert.equal(outgoing.length, 3);

runtime.available = true;
runtime.ready = true;
runtime.backendVersion = "launcher-imagegen:0.8.4:novelai";
const oldFacade = api.fn("settingsStore").getState();
assert.equal(oldFacade.imageBackendMode, "custom");
assert.equal(oldFacade.imageBackendUrl, "http://127.0.0.1:8189");
oldFacade.set({
  imageBackendMode: "off",
  imageBackendUrl: "https://wrong.example",
  keepOtherSetting: "runtime-on"
});
assert.equal(persisted.imageBackendMode, "custom", "existing facade must use live runtime status at set time");
assert.equal(persisted.imageBackendUrl, "http://127.0.0.1:8189");
assert.equal(persisted.keepOtherSetting, "runtime-on");
oldFacade.set(current => ({
  imageBackendMode: "off",
  imageBackendUrl: "https://wrong-updater.example",
  sfwMode: !current.sfwMode
}));
assert.equal(persisted.imageBackendMode, "custom");
assert.equal(persisted.imageBackendUrl, "http://127.0.0.1:8189");
assert.equal(persisted.sfwMode, true);

const localProbe = api.fn("imageBackendProbe");
await localProbe();
assert.equal(outgoing.some(item => item.probe && item.options.url === "http://127.0.0.1:8189"), true);
assert.equal(api.fn("imageBackend")().baseUrl, "http://127.0.0.1:8189");
const externalApi = await window.fetch("https://my-worker.workers.dev/api/batch/enqueue", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
});
assert.equal(externalApi.status, 200);
assert.equal(outgoing.at(-1).input, "https://my-worker.workers.dev/api/batch/enqueue",
  "foreign API hosts must not be rewritten by a saved URL matcher");
const localApi = await window.fetch("http://localhost:8189/api/batch/enqueue", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
});
assert.equal(localApi.status, 200);
assert.equal(outgoing.at(-1).input, "http://127.0.0.1:8189/api/batch/enqueue",
  "launcher-owned local API paths must retain their path and query when forwarded");
const generatedFetch = await window.fetch("https://art.sintention.com/images/portrait.png");
assert.equal(generatedFetch.status, 200);
assert.equal(outgoing.at(-1).input, "https://localhost:42000/images/__wayward_generated__/portrait.png");
const directNaiOn = await window.fetch("https://image.novelai.net/ai/generate-image", { method: "POST", body: "{}" });
assert.equal(directNaiOn.status, 503, "direct NovelAI host requests must remain blocked while the launcher is ON");
assert.equal(persisted.imageBackendUrl, "http://127.0.0.1:8189");
console.log("Image Studio setter guard, transparent local API routing, and direct-NAI block tests passed.");
