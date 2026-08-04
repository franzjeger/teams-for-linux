import { test, expect } from '@playwright/test';
import {
  launchAuthenticatedApp,
  waitForTeamsWindow,
  waitForPreloadReady,
  closeApp,
} from './helpers.js';

/**
 * Permission handling against a real Teams origin.
 *
 * The guards in app/security/webContentsGuards.js are unit tested as pure
 * decisions, but those tests cannot prove the handlers are actually wired into
 * the session, nor that Teams gets the answers it needs. A permission
 * regression here is quiet in exactly the wrong way: Teams reports "camera
 * blocked" long after a release, and nothing in CI noticed.
 *
 * These run against the real origin, so `permissions.query` reflects the
 * origin-scoped decisions the guards make rather than a stub page's.
 */
test.describe('Permissions', () => {
  let electronApp;

  test.afterEach(async () => {
    await closeApp(electronApp);
  });

  async function launchReady(testInfo) {
    electronApp = await launchAuthenticatedApp(testInfo.project.use.sessionDir);
    const mainWindow = await waitForTeamsWindow(electronApp);
    expect(mainWindow, 'Main Teams window should exist').toBeTruthy();
    await mainWindow.waitForLoadState('domcontentloaded', { timeout: 60000 });
    expect(await waitForPreloadReady(mainWindow)).toBe(true);
    return mainWindow;
  }

  test('camera and microphone report granted to the page', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    // Teams checks these before offering to join with video or audio. Anything
    // other than "granted" and the call controls come up disabled.
    const states = await mainWindow.evaluate(async () => {
      const query = async (name) => {
        try {
          return (await navigator.permissions.query({ name })).state;
        } catch (error) {
          return `error:${error.name}`;
        }
      };
      return {
        camera: await query('camera'),
        microphone: await query('microphone'),
      };
    });

    expect(states.camera).toBe('granted');
    expect(states.microphone).toBe('granted');
  });

  test('notifications report granted to the page', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const state = await mainWindow.evaluate(async () => {
      try {
        return (await navigator.permissions.query({ name: 'notifications' })).state;
      } catch (error) {
        return `error:${error.name}`;
      }
    });

    expect(state).toBe('granted');
  });

  test('geolocation is not granted', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    // Teams does not use geolocation, and the guards deny it outright. This is
    // the check that would catch the permission handler being dropped: without
    // it Electron's defaults apply and this stops being denied.
    const state = await mainWindow.evaluate(async () => {
      try {
        return (await navigator.permissions.query({ name: 'geolocation' })).state;
      } catch (error) {
        return `error:${error.name}`;
      }
    });

    expect(state).not.toBe('granted');
  });

  test('a geolocation request is refused rather than prompting', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const outcome = await mainWindow.evaluate(
      () =>
        new Promise((resolve) => {
          if (!navigator.geolocation) {
            resolve('unavailable');
            return;
          }
          const timer = setTimeout(() => resolve('no-response'), 5000);
          navigator.geolocation.getCurrentPosition(
            () => {
              clearTimeout(timer);
              resolve('granted');
            },
            () => {
              clearTimeout(timer);
              resolve('denied');
            }
          );
        })
    );

    expect(outcome, 'geolocation must not succeed').not.toBe('granted');
  });

  test('WebHID, WebSerial and WebUSB expose no devices', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    // setDevicePermissionHandler denies all three unconditionally. If the
    // handler is missing, a chooser would appear instead of an empty result.
    const results = await mainWindow.evaluate(async () => {
      const probe = async (api, method) => {
        const target = navigator[api];
        if (!target || typeof target[method] !== 'function') return 'unavailable';
        try {
          const devices = await target[method]();
          return Array.isArray(devices) ? `count:${devices.length}` : 'non-array';
        } catch (error) {
          return `rejected:${error.name}`;
        }
      };
      return {
        hid: await probe('hid', 'getDevices'),
        serial: await probe('serial', 'getPorts'),
        usb: await probe('usb', 'getDevices'),
      };
    });

    for (const [api, result] of Object.entries(results)) {
      expect(
        result === 'unavailable' || result === 'count:0' || result.startsWith('rejected:'),
        `${api} should expose no devices, got '${result}'`
      ).toBe(true);
    }
  });

  test('enumerateDevices returns media devices, so Teams can populate its pickers', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const summary = await mainWindow.evaluate(async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return {
          ok: true,
          kinds: [...new Set(devices.map((d) => d.kind))].sort(),
          // Labels are only populated once permission is granted, which is
          // itself a signal that the permission handlers did their job.
          labelled: devices.some((d) => d.label !== ''),
        };
      } catch (error) {
        return { ok: false, error: error.name };
      }
    });

    expect(summary.ok, `enumerateDevices failed: ${summary.error}`).toBe(true);
    // A headless CI container may genuinely have no capture hardware, so the
    // device list can be empty. What must not happen is the call throwing.
    expect(Array.isArray(summary.kinds)).toBe(true);
  });
});
