import { test, expect } from '@playwright/test';
import {
  launchAuthenticatedApp,
  waitForTeamsWindow,
  waitForPreloadReady,
  closeApp,
} from './helpers.js';

/**
 * Tripwires for the context isolation migration (ADR 020).
 *
 * The migration's failure mode is silence: ReactHandler returns null, its
 * callers degrade quietly, and presence, tray counts, theme and token caching
 * stop working without anything throwing. The unauthenticated suite passes
 * either way, because none of this needs a real tenant to *load*.
 *
 * Every assertion here evaluates in the PAGE world, which is where the
 * instrumentation has to end up for Teams to be affected by it. Patching a
 * global in the isolated world patches a copy the page never sees, so these
 * tests stay meaningful after the migration - a patch that quietly moved to the
 * wrong world fails here.
 *
 * The one exception is marked inline: the ReactHandler reachability test
 * asserts the current pre-migration arrangement on purpose. It must be
 * rewritten during stage 4 to go through the bridge, not deleted.
 */
test.describe('Integration surface', () => {
  let electronApp;

  test.afterEach(async () => {
    await closeApp(electronApp);
  });

  async function launchReady(testInfo, extraArgs = []) {
    electronApp = await launchAuthenticatedApp(testInfo.project.use.sessionDir, extraArgs);
    const mainWindow = await waitForTeamsWindow(electronApp);
    expect(mainWindow, 'Main Teams window should exist').toBeTruthy();
    await mainWindow.waitForLoadState('domcontentloaded', { timeout: 60000 });

    const ready = await waitForPreloadReady(mainWindow);
    expect(ready, 'Preload should have installed its page instrumentation').toBe(true);
    return mainWindow;
  }

  test('Notification is replaced by the app factory in the page world', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const notification = await mainWindow.evaluate(() => ({
      type: typeof window.Notification,
      name: window.Notification?.name,
      permission: window.Notification?.permission,
      hasRequestPermission: typeof window.Notification?.requestPermission === 'function',
    }));

    expect(notification.type).toBe('function');
    expect(notification.name).toBe('CustomNotification');
    // Teams checks this before it will emit anything.
    expect(notification.permission).toBe('granted');
    expect(notification.hasRequestPermission).toBe(true);
  });

  test('requestPermission resolves granted rather than prompting', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const result = await mainWindow.evaluate(() => window.Notification.requestPermission());
    expect(result).toBe('granted');
  });

  test('a Notification instance exposes the full lifecycle interface', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    // Without addEventListener/close/dispatchEvent, Teams' internal state
    // machine breaks after the first notification and later ones stop firing
    // entirely - a regression that has shipped before.
    const shape = await mainWindow.evaluate(() => {
      const instance = new window.Notification('probe', { body: 'probe' });
      return {
        exists: instance !== null && instance !== undefined,
        addEventListener: typeof instance?.addEventListener,
        removeEventListener: typeof instance?.removeEventListener,
        close: typeof instance?.close,
        dispatchEvent: typeof instance?.dispatchEvent,
        hasOnClick: 'onclick' in (instance ?? {}),
        hasOnClose: 'onclose' in (instance ?? {}),
      };
    });

    expect(shape.exists).toBe(true);
    expect(shape.addEventListener).toBe('function');
    expect(shape.removeEventListener).toBe('function');
    expect(shape.close).toBe('function');
    expect(shape.dispatchEvent).toBe('function');
    expect(shape.hasOnClick).toBe(true);
    expect(shape.hasOnClose).toBe(true);
  });

  test('a Notification fires its show event asynchronously', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const fired = await mainWindow.evaluate(
      () =>
        new Promise((resolve) => {
          const instance = new window.Notification('probe', { body: 'probe' });
          if (!instance || typeof instance.addEventListener !== 'function') {
            resolve(false);
            return;
          }
          const timer = setTimeout(() => resolve(false), 3000);
          instance.addEventListener('show', () => {
            clearTimeout(timer);
            resolve(true);
          });
        })
    );

    expect(fired, 'Teams relies on the show event to advance its state machine').toBe(true);
  });

  test('an enabled camera tool patches getUserMedia in the page world', async ({}, testInfo) => {
    // disableAutogain, cameraResolution and cameraAspectRatio all wrap
    // getUserMedia, and all three are opt-in and off by default - verified by
    // launching with and without this flag: default leaves the native binding
    // in place. The flag is what makes this a real assertion rather than one
    // that passes because nothing ran.
    //
    // If a patcher lands in the isolated world after the migration, the page
    // keeps calling the original and every camera fix silently reverts. That is
    // what this test exists to catch.
    const mainWindow = await launchReady(testInfo, [
      '--media.camera.autoAdjustAspectRatio.enabled=true',
    ]);

    const patched = await mainWindow.evaluate(() => {
      const fn = navigator.mediaDevices?.getUserMedia;
      if (typeof fn !== 'function') return { available: false };
      return {
        available: true,
        // A native binding stringifies as "[native code]"; a wrapper does not.
        isNative: Function.prototype.toString.call(fn).includes('[native code]'),
      };
    });

    expect(patched.available, 'mediaDevices.getUserMedia should exist').toBe(true);
    expect(
      patched.isNative,
      'getUserMedia should be wrapped by the app, not the untouched native binding'
    ).toBe(false);
  });

  test('the page-exposed privileged surface stays minimal', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    // Regression guard on the stage 1 reduction. Anything on this object is
    // callable by Teams and by anything that runs script in it, so growth here
    // is a security change and should fail loudly rather than pass review.
    const exposed = await mainWindow.evaluate(() => {
      const api = window.electronAPI;
      return api ? Object.keys(api).sort() : null;
    });

    expect(exposed, 'electronAPI should exist for the injected screen sharing script').not.toBeNull();
    expect(exposed).toEqual(['sendScreenSharingStarted', 'sendScreenSharingStopped']);
  });

  test('no Node primitives leak into the page world', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    const leaked = await mainWindow.evaluate(() =>
      ['require', 'process', 'module', 'Buffer', 'global', 'ipcRenderer'].filter(
        (name) => typeof window[name] !== 'undefined'
      )
    );

    expect(leaked, 'Page world must not reach Node or ipcRenderer').toEqual([]);
  });

  test('ReactHandler can reach Teams core services', async ({}, testInfo) => {
    const mainWindow = await launchReady(testInfo);

    // PRE-MIGRATION ASSERTION. ReactHandler is currently visible from the page
    // world because contextIsolation is false and both share one context. Under
    // ADR 020 stage 4 it moves into the main-world agent and is no longer a
    // page global, so this test must be REWRITTEN to drive it through the
    // bridge - not deleted. Deleting it removes the only check that Teams'
    // internals are still reachable at all, which is exactly the failure the
    // migration risks.
    const handler = await mainWindow.evaluate(() => {
      const instance = window.teamsForLinuxReactHandler;
      if (!instance) return { present: false };
      return {
        present: true,
        // Non-null means the React root and coreServices were both found.
        hasClientPreferences: instance.getTeams2ClientPreferences() != null,
      };
    });

    expect(handler.present, 'ReactHandler should be reachable').toBe(true);
    expect(
      handler.hasClientPreferences,
      'ReactHandler should resolve Teams core services; null means the React internals walk broke'
    ).toBe(true);
  });
});
