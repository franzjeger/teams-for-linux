/**
 * Managed Policy Module
 *
 * Enterprise deployments need settings that IT can enforce and users cannot
 * override. The system-wide config file (/etc/teams-for-linux/config.json) may
 * declare a `managedPolicy` section listing which settings are locked:
 *
 *   {
 *     "managedPolicy": {
 *       "lockedSettings": ["url", "disableAutoUpdate", "mqtt.enabled"],
 *       "lockAll": false
 *     },
 *     "url": "https://teams.microsoft.com/v2",
 *     "disableAutoUpdate": true,
 *     "mqtt": { "enabled": false }
 *   }
 *
 * Locked settings keep their system-wide value regardless of what the user
 * config file, environment variables or command line arguments say. Everything
 * else keeps the historical behaviour where user config wins.
 *
 * Enforcement runs twice: once when merging config files, and again after
 * yargs has parsed env vars and CLI arguments, so no input path can bypass it.
 */

const POLICY_KEY = "managedPolicy";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Reads a dot-separated path from an object.
 * @returns {{found: boolean, value: unknown}}
 */
function getPath(target, dottedPath) {
  const segments = dottedPath.split(".");
  let current = target;

  for (const segment of segments) {
    if (UNSAFE_KEYS.has(segment)) return { found: false, value: undefined };
    if (!isPlainObject(current) || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }

  return { found: true, value: current };
}

/**
 * Writes a dot-separated path into an object, creating intermediate objects.
 * Returns false when the path cannot be written safely.
 */
function setPath(target, dottedPath, value) {
  const segments = dottedPath.split(".");
  if (segments.some((segment) => UNSAFE_KEYS.has(segment) || segment === "")) {
    return false;
  }

  let current = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }

  current[segments[segments.length - 1]] = value;
  return true;
}

/**
 * Builds the effective policy from a system-wide config object.
 *
 * @param {object} systemConfig - Parsed contents of the system-wide config file
 * @returns {{isManaged: boolean, lockAll: boolean, lockedSettings: string[], values: object}}
 */
function buildPolicy(systemConfig) {
  const empty = {
    isManaged: false,
    lockAll: false,
    lockedSettings: [],
    values: {},
  };

  if (!isPlainObject(systemConfig)) return empty;

  const policy = systemConfig[POLICY_KEY];
  if (!isPlainObject(policy)) return empty;

  const lockAll = policy.lockAll === true;
  const declared = Array.isArray(policy.lockedSettings)
    ? policy.lockedSettings.filter(
        (entry) => typeof entry === "string" && entry.length > 0
      )
    : [];

  // lockAll locks every setting the system config actually defines, so an
  // administrator can enforce a full baseline without listing each key.
  const lockedSettings = lockAll
    ? Object.keys(systemConfig).filter((key) => key !== POLICY_KEY)
    : declared;

  const values = {};
  for (const setting of lockedSettings) {
    const { found, value } = getPath(systemConfig, setting);
    if (found) {
      setPath(values, setting, value);
    }
  }

  const uniqueLocked = [...new Set(lockedSettings)];

  return {
    isManaged: uniqueLocked.length > 0,
    lockAll,
    lockedSettings: uniqueLocked,
    values,
  };
}

/**
 * Merges user config over system config while keeping locked settings pinned to
 * their system-wide values.
 *
 * @returns {{merged: object, blocked: string[]}} blocked lists settings the user
 *          config tried to change but could not.
 */
function mergeWithPolicy(systemConfig, userConfig, policy) {
  const system = isPlainObject(systemConfig) ? systemConfig : {};
  const user = isPlainObject(userConfig) ? userConfig : {};

  const merged = { ...system, ...user };
  delete merged[POLICY_KEY];

  const blocked = [];
  for (const setting of policy.lockedSettings) {
    const policyValue = getPath(policy.values, setting);
    if (!policyValue.found) continue;

    const userValue = getPath(user, setting);
    if (userValue.found && !deepEquals(userValue.value, policyValue.value)) {
      blocked.push(setting);
    }

    setPath(merged, setting, policyValue.value);
  }

  return { merged, blocked };
}

/**
 * Re-applies locked settings after yargs has merged env vars and CLI arguments.
 * Mutates the config in place and returns the settings that had to be corrected.
 *
 * @returns {string[]} settings whose value was reset to the policy value
 */
function enforcePolicy(config, policy) {
  if (!policy.isManaged || !isPlainObject(config)) return [];

  const corrected = [];
  for (const setting of policy.lockedSettings) {
    const policyValue = getPath(policy.values, setting);
    if (!policyValue.found) continue;

    const currentValue = getPath(config, setting);
    if (currentValue.found && deepEquals(currentValue.value, policyValue.value)) {
      continue;
    }

    if (setPath(config, setting, policyValue.value)) {
      corrected.push(setting);
    }
  }

  return corrected;
}

/**
 * Structural comparison used to decide whether an override actually changed a
 * value. Key order is ignored so reformatted config files do not report as
 * override attempts.
 */
function deepEquals(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEquals(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.hasOwn(b, key) && deepEquals(a[key], b[key])
    );
  }

  return false;
}

module.exports = {
  POLICY_KEY,
  buildPolicy,
  mergeWithPolicy,
  enforcePolicy,
  // Exported for tests
  getPath,
  setPath,
  deepEquals,
};
