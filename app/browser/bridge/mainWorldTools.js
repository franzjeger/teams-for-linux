'use strict';

/**
 * Main-World Tool Loader
 *
 * Stage 3 of ADR 020. Moves the browser tools that patch page globals out of
 * the preload and into the page world, where their patches actually affect
 * Teams once `contextIsolation` is enabled.
 *
 * Why these tools specifically: `getUserMedia` patched from the isolated world
 * patches a copy the page never calls. The patch has to be installed on the
 * page's own `navigator.mediaDevices`, which means running in the page world.
 *
 * The tool files stay the single source of truth. Rather than duplicating them
 * into an agent bundle, their source is read at runtime and wrapped in a
 * CommonJS shim, so `module.exports = { init }` keeps working unchanged. This
 * only works because these three tools have no `require` calls of their own -
 * enforced by `assertNoRequires` below, so a future import turns into a clear
 * error instead of a silent `require is not defined` in the page.
 *
 * Tools that need `ipcRenderer` cannot move this way; they need the bridge.
 * Tools that reach Teams' React internals belong to stage 4.
 */

const fs = require("node:fs");
const path = require("node:path");

const TOOLS_DIR = path.join(__dirname, "..", "tools");

/**
 * Tools moved to the page world.
 *
 * Deliberately excluded:
 * - `speakingIndicator` requires `activityHub`, which requires `reactHandler`.
 *   Its RTCPeerConnection patch looks like a stage 3 candidate, but the module
 *   level import drags the React internals in with it. Stage 4.
 * - The Notification override needs to call back into the preload for sound and
 *   toast delivery, so it needs bridge events rather than a plain injection.
 */
const MAIN_WORLD_TOOLS = ["disableAutogain", "cameraResolution", "cameraAspectRatio"];

/**
 * A `require` in a tool would throw in the page world, where no module loader
 * exists. Fail loudly at build time instead.
 */
function assertNoRequires(name, source) {
  // Matches a require call, not the word inside a comment or string.
  if (/(^|[^\w.])require\s*\(/.test(source)) {
    throw new Error(
      `main-world tool '${name}' contains a require() call and cannot run in the page world. ` +
        `Either inline the dependency or move the tool to the bridge.`
    );
  }
}

function readToolSource(name) {
  const file = path.join(TOOLS_DIR, `${name}.js`);
  const source = fs.readFileSync(file, "utf8");
  assertNoRequires(name, source);
  return source;
}

/**
 * Builds the injectable source for the given tools.
 *
 * Tool source is concatenated as real code rather than embedded as a string, so
 * nothing needs escaping. Config is JSON-encoded. The result is delivered via
 * `injectAgent`, which assigns to `script.textContent` - that is not
 * HTML-parsed, so a `</script>` sequence in a tool could not terminate it
 * either.
 *
 * @param {object} config - application config, as the tools' `init` expects
 * @param {string[]} [toolNames]
 * @returns {string}
 */
function buildToolsSource(config, toolNames = MAIN_WORLD_TOOLS) {
  const blocks = toolNames.map((name) => {
    const source = readToolSource(name);
    return `
  // ---- ${name} ----
  try {
    var module = { exports: {} };
    var exports = module.exports;
${source}
    __tools[${JSON.stringify(name)}] = module.exports;
  } catch (error) {
    console.error("[MAIN_WORLD_TOOLS] Failed to define ${name}:", error && error.message);
  }
`;
  });

  return `(function (config) {
  "use strict";
  var __tools = {};
${blocks.join("\n")}
  var __loaded = [];
  Object.keys(__tools).forEach(function (name) {
    try {
      var tool = __tools[name];
      if (tool && typeof tool.init === "function") {
        tool.init(config);
        __loaded.push(name);
      }
    } catch (error) {
      // One failing tool must not stop the others; the preload tolerates the
      // same failure today.
      console.error("[MAIN_WORLD_TOOLS] " + name + " init failed:", error && error.message);
    }
  });
  console.info("[MAIN_WORLD_TOOLS] Initialised " + __loaded.length + "/" + Object.keys(__tools).length + " page-world tools");
})(${JSON.stringify(config ?? {})});`;
}

/**
 * Config subset handed to the page world.
 *
 * The whole config object must not cross: it is reachable by any script in the
 * page once injected, and it carries proxy settings, SSO account hints and
 * custom service URLs. Only the branches these tools actually read are copied.
 */
function pickToolConfig(config) {
  const media = config?.media ?? {};
  return {
    // disableAutogain reads both the nested and the deprecated flat form.
    disableAutogain: config?.disableAutogain === true,
    media: {
      microphone: {
        disableAutogain: media.microphone?.disableAutogain === true,
      },
      camera: {
        resolution: media.camera?.resolution ?? { enabled: false },
        autoAdjustAspectRatio: media.camera?.autoAdjustAspectRatio ?? { enabled: false },
      },
    },
  };
}

module.exports = {
  MAIN_WORLD_TOOLS,
  buildToolsSource,
  pickToolConfig,
  // Exported for tests
  assertNoRequires,
};
