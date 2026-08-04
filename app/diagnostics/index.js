/**
 * Diagnostics Module
 *
 * Supportability for managed deployments:
 *
 * - Starts Electron's crashReporter so renderer and GPU process crashes leave a
 *   minidump behind. Dumps stay local unless an administrator configures an
 *   upload endpoint.
 * - Produces a diagnostics bundle a user can hand to their helpdesk, containing
 *   version, platform, session and configuration information plus a tail of the
 *   log file.
 *
 * Everything written into a bundle passes through the PII sanitizer, and
 * configuration keys that hold secrets or internal infrastructure names are
 * redacted before that.
 */

const { app, crashReporter, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { sanitize } = require("../utils/logSanitizer");

/**
 * Configuration keys removed from a diagnostics bundle. These hold credentials,
 * account identifiers or internal infrastructure names that must not leave the
 * machine in a support ticket. Dotted paths address nested settings.
 */
const REDACTED_CONFIG_KEYS = [
  "clientCertPassword",
  "clientCertPath",
  "ssoBasicAuthUser",
  "ssoBasicAuthPasswordCommand",
  "ssoInTuneAuthUser",
  "authServerWhitelist",
  "proxyServer",
  "customBGServiceBaseUrl",
  "customCACertsFingerprints",
  "mqtt.url",
  "mqtt.username",
  "mqtt.password",
  "mqtt.clientId",
  "graphApi.clientId",
  "graphApi.tenantId",
];

const LOG_TAIL_BYTES = 64 * 1024;

let crashReporterStarted = false;

/**
 * Starts the crash reporter. Must run before the app is ready so early crashes
 * are captured.
 *
 * Dumps are written to app.getPath('crashDumps') and stay on the machine.
 * Uploading requires an administrator to set both `enabled` and `submitURL`;
 * there is no default endpoint and no telemetry is sent otherwise.
 */
function initializeCrashReporter(config) {
  const settings = config?.crashReporter ?? {};

  if (settings.enabled === false) {
    console.info("[DIAGNOSTICS] Crash reporter disabled by configuration");
    return false;
  }

  const submitURL =
    typeof settings.submitURL === "string" ? settings.submitURL.trim() : "";
  const uploadToServer = settings.uploadToServer === true && submitURL !== "";

  if (settings.uploadToServer === true && submitURL === "") {
    console.warn(
      "[DIAGNOSTICS] Crash upload requested without submitURL; keeping dumps local"
    );
  }

  try {
    crashReporter.start({
      productName: "teams-for-linux",
      companyName: "teams-for-linux",
      submitURL: uploadToServer ? submitURL : undefined,
      uploadToServer,
      compress: settings.compress !== false,
      // Never attach configuration or account data here; extras are uploaded
      // verbatim alongside the minidump.
      extra: {},
    });
    crashReporterStarted = true;
    console.info("[DIAGNOSTICS] Crash reporter started", { uploadToServer });
    return true;
  } catch (error) {
    console.error("[DIAGNOSTICS] Failed to start crash reporter", {
      message: error.message,
    });
    return false;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-clones a config object with sensitive keys replaced by a marker.
 */
function redactConfig(config) {
  if (!isPlainObject(config)) return {};

  let clone;
  try {
    clone = structuredClone(config);
  } catch {
    // Config can carry non-cloneable values once modules have touched it.
    try {
      clone = JSON.parse(JSON.stringify(config));
    } catch {
      return { error: "configuration could not be serialised" };
    }
  }

  for (const dottedPath of REDACTED_CONFIG_KEYS) {
    const segments = dottedPath.split(".");
    let cursor = clone;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!isPlainObject(cursor[segments[i]])) {
        cursor = null;
        break;
      }
      cursor = cursor[segments[i]];
    }

    const leaf = segments[segments.length - 1];
    if (cursor && Object.hasOwn(cursor, leaf) && cursor[leaf] !== undefined) {
      cursor[leaf] = "[REDACTED]";
    }
  }

  return clone;
}

/**
 * Lists crash dumps without reading them. Filenames only - the dumps themselves
 * can contain process memory and are never inlined into a bundle.
 */
function listCrashDumps() {
  try {
    const dumpDir = app.getPath("crashDumps");
    const completedDir = path.join(dumpDir, "completed");
    const dir = fs.existsSync(completedDir) ? completedDir : dumpDir;
    if (!fs.existsSync(dir)) return { directory: dir, count: 0, recent: [] };

    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".dmp"))
      .map((name) => {
        const stats = fs.statSync(path.join(dir, name));
        return { name, sizeBytes: stats.size, modified: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));

    return { directory: dir, count: entries.length, recent: entries.slice(0, 10) };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Returns the tail of the current log file, sanitized.
 */
function readLogTail() {
  try {
    const log = require("electron-log/main");
    const file = log.transports?.file?.getFile?.();
    if (!file?.path || !fs.existsSync(file.path)) {
      return { available: false, reason: "file logging is not enabled" };
    }

    const { size } = fs.statSync(file.path);
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const handle = fs.openSync(file.path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      return {
        available: true,
        truncated: start > 0,
        bytes: buffer.length,
        content: sanitize(buffer.toString("utf8")),
      };
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

function detectSessionType() {
  return {
    xdgSessionType: process.env.XDG_SESSION_TYPE ?? null,
    waylandDisplay: process.env.WAYLAND_DISPLAY ? "set" : null,
    x11Display: process.env.DISPLAY ? "set" : null,
    desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
    // Presence only - the value can identify the distribution build host.
    isSnap: Boolean(process.env.SNAP),
    isFlatpak: Boolean(process.env.FLATPAK_ID),
    isAppImage: Boolean(process.env.APPIMAGE),
  };
}

/**
 * Builds the diagnostics payload. Safe to hand to a helpdesk: secrets are
 * redacted and everything else is sanitized.
 */
function collectDiagnostics(config, timestamp) {
  const payload = {
    generatedAt: timestamp,
    application: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      locale: app.getLocale(),
      systemLocale: app.getSystemLocale(),
    },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    platform: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      cpuCount: os.cpus().length,
      uptimeSeconds: Math.round(os.uptime()),
    },
    session: detectSessionType(),
    policy: config?.managedPolicy ?? { isManaged: false },
    crashReporter: {
      started: crashReporterStarted,
      dumps: listCrashDumps(),
    },
    configuration: redactConfig(config),
    log: readLogTail(),
  };

  return payload;
}

/**
 * Prompts for a location and writes the diagnostics bundle there.
 *
 * @returns {Promise<string|null>} the path written, or null if cancelled
 */
async function saveDiagnosticsBundle(window, config, timestamp) {
  const stamp = timestamp.replace(/[:.]/g, "-");
  const defaultPath = path.join(
    app.getPath("downloads"),
    `teams-for-linux-diagnostics-${stamp}.json`
  );

  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: "Save Diagnostics",
    defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (canceled || !filePath) return null;

  const payload = collectDiagnostics(config, timestamp);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.info("[DIAGNOSTICS] Diagnostics bundle written");
  return filePath;
}

module.exports = {
  initializeCrashReporter,
  collectDiagnostics,
  saveDiagnosticsBundle,
  // Exported for tests
  redactConfig,
  REDACTED_CONFIG_KEYS,
};
