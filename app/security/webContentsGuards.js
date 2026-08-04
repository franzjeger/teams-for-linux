/**
 * WebContents Security Guards
 *
 * The main window renders remote content (the Teams web app). Electron grants
 * several capabilities to remote content by default, and until now nothing in
 * this application constrained them: there was no permission request handler,
 * no permission check handler, no device permission handler and no navigation
 * guard.
 *
 * This module supplies those handlers. The decision logic is kept pure so it
 * can be unit tested without an Electron runtime; `applyWebContentsGuards`
 * wires the decisions into a session and a WebContents.
 *
 * Design notes:
 *
 * - Permissions are default-deny. A permission Electron adds in a future
 *   version is denied until it is explicitly considered here.
 * - The powerful permissions (camera, microphone, screen capture, opening
 *   external handlers) additionally require a trusted origin.
 * - Navigation is *not* restricted by default. Enterprise SSO redirects
 *   through identity providers on customer-controlled domains that cannot be
 *   known in advance, so a default-on allowlist would break sign-in. Setting
 *   `security.restrictNavigation` turns enforcement on for deployments that
 *   can enumerate their identity provider domains.
 */

const { shell } = require("electron");

/**
 * Domain suffixes belonging to Microsoft services that Teams legitimately
 * navigates through, including the authentication and CDN endpoints.
 */
const TRUSTED_DOMAIN_SUFFIXES = [
  "teams.microsoft.com",
  "teams.live.com",
  "teams.cloud.microsoft",
  "microsoft.com",
  "microsoftonline.com",
  "microsoftonline-p.com",
  "msauth.net",
  "msftauth.net",
  "office.com",
  "office.net",
  "office365.com",
  "cloud.microsoft",
  "sharepoint.com",
  "skype.com",
  "live.com",
  "azureedge.net",
  "akamaized.net",
  "msecnd.net",
  "trafficmanager.net",
];

/**
 * Permissions the Teams web app needs to function.
 */
const ALLOWED_PERMISSIONS = new Set([
  "background-sync",
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "fullscreen",
  "media",
  "mediaKeySystem",
  "notifications",
  "openExternal",
  "pointerLock",
  "speaker-selection",
  // Required for authentication flows running in embedded frames.
  "storage-access",
  "top-level-storage-access",
]);

/**
 * Permissions powerful enough that a trusted origin is required as well.
 */
const ORIGIN_SCOPED_PERMISSIONS = new Set([
  "display-capture",
  "media",
  "openExternal",
]);

/**
 * Device APIs the Teams web app does not use. Denied unconditionally.
 */
const DENIED_DEVICE_PERMISSIONS = ["hid", "serial", "usb"];

function parseOrigin(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Builds the set of trusted domain suffixes for a configuration: the built-in
 * Microsoft endpoints, the configured Teams URL, and any additional origins an
 * administrator has declared.
 */
function buildTrustedDomains(config) {
  const domains = new Set(TRUSTED_DOMAIN_SUFFIXES);

  const configuredUrl = parseOrigin(config?.url);
  if (configuredUrl?.hostname) {
    domains.add(configuredUrl.hostname.toLowerCase());
  }

  const additional = config?.security?.additionalTrustedOrigins;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      const parsed = parseOrigin(entry);
      const hostname = parsed?.hostname ?? entry.trim();
      domains.add(hostname.toLowerCase().replace(/^\*\./, ""));
    }
  }

  return domains;
}

/**
 * True when `url` is served from a trusted domain or a subdomain of one.
 *
 * Matching is on domain-label boundaries, so "notmicrosoft.com" does not match
 * the "microsoft.com" suffix.
 */
function isTrustedUrl(url, trustedDomains) {
  const parsed = parseOrigin(url);
  if (!parsed) return false;

  // Only these schemes can be trusted; file: and custom schemes never are.
  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") return false;

  const hostname = parsed.hostname.toLowerCase();
  for (const domain of trustedDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Decides a permission request.
 *
 * @param {string} permission - Electron permission name
 * @param {string} requestingUrl - URL of the frame making the request
 * @param {Set<string>} trustedDomains
 * @returns {{granted: boolean, reason: string}}
 */
function decidePermission(permission, requestingUrl, trustedDomains) {
  if (typeof permission !== "string" || permission === "") {
    return { granted: false, reason: "malformed permission" };
  }

  if (!ALLOWED_PERMISSIONS.has(permission)) {
    return { granted: false, reason: "permission not required by Teams" };
  }

  if (ORIGIN_SCOPED_PERMISSIONS.has(permission)) {
    if (!isTrustedUrl(requestingUrl, trustedDomains)) {
      return { granted: false, reason: "untrusted origin" };
    }
  }

  return { granted: true, reason: "allowed" };
}

/**
 * Decides whether a navigation may proceed in the main window.
 *
 * @returns {{allowed: boolean, reason: string}}
 */
function decideNavigation(url, trustedDomains, restrictNavigation) {
  const parsed = parseOrigin(url);
  if (!parsed) return { allowed: false, reason: "malformed URL" };

  // In-page targets and the blank page are part of normal operation.
  if (parsed.protocol === "about:") return { allowed: true, reason: "about:" };

  if (!restrictNavigation) {
    return {
      allowed: true,
      reason: isTrustedUrl(url, trustedDomains)
        ? "trusted"
        : "unrestricted (navigation restriction disabled)",
    };
  }

  if (isTrustedUrl(url, trustedDomains)) {
    return { allowed: true, reason: "trusted" };
  }

  return { allowed: false, reason: "origin not in navigation allowlist" };
}

/**
 * Safe webPreferences forced onto any <webview> that tries to attach.
 */
function hardenWebviewPreferences(webPreferences, params) {
  // A preload set by remote content would run with elevated privileges.
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;

  if (params) {
    delete params.preload;
    params.nodeintegration = "false";
  }
}

/**
 * Wires the guards into a session and its WebContents.
 *
 * @param {Electron.Session} session
 * @param {Electron.WebContents} webContents
 * @param {object} config
 */
function applyWebContentsGuards(session, webContents, config) {
  const trustedDomains = buildTrustedDomains(config);
  const restrictNavigation = config?.security?.restrictNavigation === true;

  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl ?? "";
    const { granted, reason } = decidePermission(
      permission,
      requestingUrl,
      trustedDomains
    );

    if (!granted) {
      // The permission name is safe to log; the requesting URL is not, as
      // query parameters can carry tokens.
      console.warn("[SECURITY] Permission denied", { permission, reason });
    }

    callback(granted);
  });

  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const { granted } = decidePermission(
      permission,
      requestingOrigin,
      trustedDomains
    );
    return granted;
  });

  // Teams does not use WebHID, WebSerial or WebUSB.
  session.setDevicePermissionHandler((details) => {
    console.warn("[SECURITY] Device permission denied", {
      deviceType: details?.deviceType,
    });
    return false;
  });

  webContents.on("will-navigate", (event, url) => {
    const { allowed, reason } = decideNavigation(
      url,
      trustedDomains,
      restrictNavigation
    );

    if (allowed) return;

    event.preventDefault();
    console.warn("[SECURITY] Navigation blocked", { reason });

    // The user asked to go somewhere; hand it to the browser rather than
    // silently doing nothing.
    const parsed = parseOrigin(url);
    if (parsed?.protocol === "https:" || parsed?.protocol === "http:") {
      shell.openExternal(url).catch((error) => {
        console.error("[SECURITY] Failed to open blocked URL externally", {
          message: error.message,
        });
      });
    }
  });

  // No <webview> is used by this application. If remote content manages to
  // attach one, it starts fully locked down.
  webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    console.warn("[SECURITY] webview attach hardened");
    hardenWebviewPreferences(webPreferences, params);
  });

  console.info("[SECURITY] WebContents guards applied", {
    trustedDomainCount: trustedDomains.size,
    restrictNavigation,
  });
}

module.exports = {
  applyWebContentsGuards,
  // Exported for tests
  buildTrustedDomains,
  isTrustedUrl,
  decidePermission,
  decideNavigation,
  hardenWebviewPreferences,
  ALLOWED_PERMISSIONS,
  ORIGIN_SCOPED_PERMISSIONS,
  DENIED_DEVICE_PERMISSIONS,
  TRUSTED_DOMAIN_SUFFIXES,
};
