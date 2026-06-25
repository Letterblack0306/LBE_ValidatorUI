// Adapter between the Runtime Health UI and Electron/renderer runtime.
// It is intentionally defensive: if a handler is missing, the UI shows SKIP/FAIL evidence instead of crashing.

import { buildRuntimeProofGraph, DEFAULT_EXPECTED_RELAY_PORT } from './runtime-health-schema.mjs';

const runtimeErrors = [];
const uiMisfires = [];

function captureError(kind, event) {
  const error = event?.error || event?.reason || event;
  runtimeErrors.unshift({
    kind,
    name: error?.name || kind,
    message: error?.message || String(error),
    stack: error?.stack || null,
    timestamp: new Date().toISOString(),
  });
  runtimeErrors.splice(20);
}

if (typeof window !== 'undefined' && !window.__runtimeHealthErrorCaptureInstalled) {
  window.__runtimeHealthErrorCaptureInstalled = true;
  window.addEventListener('error', (event) => captureError('window.error', event));
  window.addEventListener('unhandledrejection', (event) => captureError('unhandledrejection', event));
}

export function resolveInvoke(explicitInvoke) {
  if (typeof explicitInvoke === 'function') return explicitInvoke;
  if (typeof window === 'undefined') return null;

  const candidates = [
    window.gptSync?.invoke,
    window.electronAPI?.invoke,
    window.api?.invoke,
    window.electron?.invoke,
    window.ipcRenderer?.invoke,
  ];

  for (const fn of candidates) {
    if (typeof fn === 'function') return fn.bind(fn === window.ipcRenderer?.invoke ? window.ipcRenderer : undefined);
  }

  // Common preload shape: window.api.relayStatus() etc. is handled in safeInvoke.
  return null;
}

async function safeInvoke(channel, invoke, fallback = null) {
  try {
    if (invoke) return await invoke(channel);

    if (typeof window !== 'undefined') {
      const api = window.gptSync || window.electronAPI || window.api || window.electron;
      const camel = channel.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (typeof api?.[camel] === 'function') return await api[camel]();
      if (typeof api?.[channel] === 'function') return await api[channel]();
    }

    return fallback ?? { ok: false, skipped: true, error: `No IPC bridge available for ${channel}` };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), channel };
  }
}

export function scanUiWiring(root = document) {
  if (!root?.querySelectorAll) {
    return { checked: false, missingHandlers: [], controls: [], error: 'No DOM root supplied.' };
  }

  const controls = [...root.querySelectorAll('button, [role="button"], [data-action], [data-module]')];
  const missingHandlers = [];

  for (const el of controls) {
    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);
    if (!visible) continue;

    const label = (el.getAttribute('aria-label') || el.textContent || el.id || el.dataset.action || el.dataset.module || '').trim();
    const hasDeclarativeTarget = !!(el.dataset.action || el.dataset.module || el.getAttribute('data-route') || el.getAttribute('href'));
    const hasInlineHandler = typeof el.onclick === 'function' || el.hasAttribute('onclick');
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';

    // Browser JS cannot reliably introspect addEventListener listeners. Therefore this checks the contract:
    // each visible control must expose a route/action/module OR an inline handler OR be disabled.
    if (!disabled && !hasDeclarativeTarget && !hasInlineHandler) {
      missingHandlers.push({
        label: label || '<unlabelled control>',
        id: el.id || null,
        className: el.className || null,
        tagName: el.tagName,
        reason: 'Visible control has no data-action/data-module/data-route/href/onclick contract.',
      });
    }
  }

  return {
    checked: true,
    totalControls: controls.length,
    missingHandlers,
    lastMisfire: uiMisfires[0] || null,
  };
}

export function reportUiMisfire(payload) {
  uiMisfires.unshift({
    ...payload,
    timestamp: new Date().toISOString(),
  });
  uiMisfires.splice(20);
}

export async function collectRuntimeHealth(options = {}) {
  const invoke = resolveInvoke(options.invoke);
  const expectedRelayPort = options.expectedRelayPort ?? DEFAULT_EXPECTED_RELAY_PORT;
  const extensionRelayUrl = options.extensionRelayUrl ?? `http://127.0.0.1:${expectedRelayPort}`;

  const [relayStatus, relayTabs, actionRoundtrip, routeHealth] = await Promise.all([
    safeInvoke('relay-status', invoke, { ok: false, running: false, error: 'relay-status IPC unavailable' }),
    safeInvoke('relay-tabs', invoke, { ok: false, tabs: [], error: 'relay-tabs IPC unavailable' }),
    options.runActionRoundtrip ? options.runActionRoundtrip() : Promise.resolve(null),
    options.collectRouteHealth ? options.collectRouteHealth() : Promise.resolve({ checked: false }),
  ]);

  const uiHealth = options.scanUi === false
    ? { checked: false }
    : scanUiWiring(options.root || document);

  return buildRuntimeProofGraph({
    relayStatus,
    relayTabs,
    expectedRelayPort,
    extensionRelayUrl,
    actionRoundtrip,
    uiHealth,
    routeHealth,
    runtimeErrors: [...runtimeErrors],
  });
}
