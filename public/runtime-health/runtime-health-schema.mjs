// Runtime Health proof schema for GPT Sync / Electron UI.
// Pure module: no DOM, no Electron dependency.

export const STATUS = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
});

export const LANES = Object.freeze({
  REPO: 'Git / Repo',
  BUILD: 'Build / Release',
  PUBLIC_CLONE: 'Public Clone',
  RUNTIME_RELAY: 'Runtime Relay',
  BROWSER_ACTION: 'Browser Action',
  UI_EVENT: 'UI Event / Button Wiring',
  AGENT_ROUTE: 'Agent Decision / Tool Route',
});

export const DEFAULT_EXPECTED_RELAY_PORT = 4424;

function toBool(value) {
  return value === true;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function node({ id, label, lane, status, details, evidence, dependsOn = [] }) {
  return {
    id,
    label,
    lane,
    status,
    details: details || '',
    evidence: evidence ?? null,
    dependsOn,
    timestamp: new Date().toISOString(),
  };
}

function edge(from, to) {
  return { from, to };
}

function failSafeStatus(condition, pass = STATUS.PASS, fail = STATUS.FAIL) {
  return condition ? pass : fail;
}

function relayPortFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return toNumber(new URL(url).port);
  } catch {
    const match = String(url).match(/:(\d{2,5})(?:\/|$)/);
    return match ? toNumber(match[1]) : null;
  }
}

export function normalizeRelayStatus(relayStatus) {
  const r = relayStatus && typeof relayStatus === 'object' ? relayStatus : {};
  return {
    ok: toBool(r.ok),
    running: toBool(r.running),
    connected: toBool(r.connected),
    port: toNumber(r.port),
    tabCount: toNumber(r.tabCount) ?? 0,
    cdpPort: toNumber(r.cdpPort),
    portConflict: toBool(r.portConflict),
    error: typeof r.error === 'string' ? r.error : '',
    diagnosis: Array.isArray(r.diagnosis) ? r.diagnosis.filter(Boolean).map(String) : [],
    raw: r,
  };
}

export function normalizeRelayTabs(relayTabs) {
  if (Array.isArray(relayTabs)) return relayTabs;
  if (relayTabs && Array.isArray(relayTabs.tabs)) return relayTabs.tabs;
  return [];
}

export function buildRuntimeProofGraph(input = {}) {
  const relay = normalizeRelayStatus(input.relayStatus);
  const tabs = normalizeRelayTabs(input.relayTabs);
  const expectedRelayPort = toNumber(input.expectedRelayPort) ?? DEFAULT_EXPECTED_RELAY_PORT;
  const extensionRelayUrl = input.extensionRelayUrl || `http://127.0.0.1:${expectedRelayPort}`;
  const extensionPort = relayPortFromUrl(extensionRelayUrl) ?? expectedRelayPort;
  const uiHealth = input.uiHealth && typeof input.uiHealth === 'object' ? input.uiHealth : {};
  const routeHealth = input.routeHealth && typeof input.routeHealth === 'object' ? input.routeHealth : {};
  const actionRoundtrip = input.actionRoundtrip && typeof input.actionRoundtrip === 'object' ? input.actionRoundtrip : null;
  const runtimeErrors = Array.isArray(input.runtimeErrors) ? input.runtimeErrors : [];

  const relayStatusEvidence = {
    relayStatus: relay.raw,
    extensionRelayUrl,
    expectedRelayPort,
    extensionPort,
  };

  const nodes = [
    node({
      id: 'relay_server_started',
      label: 'Relay server started',
      lane: LANES.RUNTIME_RELAY,
      status: failSafeStatus(relay.running),
      details: relay.running ? `Relay process is running on port ${relay.port}.` : (relay.error || 'Relay server is not running.'),
      evidence: relayStatusEvidence,
    }),
    node({
      id: 'relay_port_matches_extension',
      label: 'Relay port matches extension',
      lane: LANES.RUNTIME_RELAY,
      status: failSafeStatus(relay.running && relay.port === extensionPort),
      details: relay.port === extensionPort
        ? `Relay and extension both use ${extensionPort}.`
        : `Relay port ${relay.port ?? 'unknown'} does not match extension port ${extensionPort}.`,
      evidence: relayStatusEvidence,
      dependsOn: ['relay_server_started'],
    }),
    node({
      id: 'relay_extension_connected',
      label: 'Relay extension connected',
      lane: LANES.RUNTIME_RELAY,
      status: relay.running ? failSafeStatus(relay.connected) : STATUS.SKIP,
      details: relay.connected ? 'Extension WebSocket is authenticated and connected.' : 'Relay is running but no extension connection is active.',
      evidence: relayStatusEvidence,
      dependsOn: ['relay_port_matches_extension'],
    }),
    node({
      id: 'relay_enabled_tab_exists',
      label: 'Enabled browser tab exists',
      lane: LANES.RUNTIME_RELAY,
      status: relay.connected ? failSafeStatus(relay.tabCount > 0, STATUS.PASS, STATUS.WARN) : STATUS.SKIP,
      details: relay.tabCount > 0 ? `${relay.tabCount} enabled relay tab(s).` : 'Extension connected, but no enabled browser tab is registered.',
      evidence: { tabCount: relay.tabCount, tabs },
      dependsOn: ['relay_extension_connected'],
    }),
    node({
      id: 'relay_cdp_port_not_conflicting',
      label: 'CDP port not conflicting',
      lane: LANES.RUNTIME_RELAY,
      status: relay.portConflict ? STATUS.FAIL : STATUS.PASS,
      details: relay.portConflict ? `CDP port conflicts with relay port ${relay.port}.` : 'CDP port does not conflict with relay server port.',
      evidence: { relayPort: relay.port, cdpPort: relay.cdpPort, portConflict: relay.portConflict },
      dependsOn: ['relay_server_started'],
    }),
    node({
      id: 'relay_action_roundtrip',
      label: 'Relay action roundtrip',
      lane: LANES.BROWSER_ACTION,
      status: actionRoundtrip ? failSafeStatus(actionRoundtrip.ok) : STATUS.SKIP,
      details: actionRoundtrip ? (actionRoundtrip.ok ? 'Browser relay accepted and returned an action result.' : (actionRoundtrip.error || 'Relay action roundtrip failed.')) : 'No action roundtrip proof attached yet.',
      evidence: actionRoundtrip,
      dependsOn: ['relay_enabled_tab_exists', 'relay_cdp_port_not_conflicting'],
    }),
    node({
      id: 'ui_buttons_have_handlers',
      label: 'UI buttons have handlers',
      lane: LANES.UI_EVENT,
      status: uiHealth.missingHandlers?.length ? STATUS.FAIL : (uiHealth.checked ? STATUS.PASS : STATUS.SKIP),
      details: uiHealth.missingHandlers?.length ? `${uiHealth.missingHandlers.length} UI control(s) have no handler.` : (uiHealth.checked ? 'Visible UI controls expose handlers.' : 'UI wiring scan not executed.'),
      evidence: uiHealth,
    }),
    node({
      id: 'ui_no_recent_misfire',
      label: 'No recent UI misfire',
      lane: LANES.UI_EVENT,
      status: uiHealth.lastMisfire ? STATUS.FAIL : (uiHealth.checked ? STATUS.PASS : STATUS.SKIP),
      details: uiHealth.lastMisfire ? `Last UI misfire: ${uiHealth.lastMisfire.message || uiHealth.lastMisfire.type || 'unknown'}` : (uiHealth.checked ? 'No UI misfire recorded.' : 'No UI misfire tracker attached.'),
      evidence: uiHealth.lastMisfire || null,
      dependsOn: ['ui_buttons_have_handlers'],
    }),
    node({
      id: 'agent_tool_route_known',
      label: 'Agent tool route known',
      lane: LANES.AGENT_ROUTE,
      status: routeHealth.missingRoute ? STATUS.FAIL : (routeHealth.checked ? STATUS.PASS : STATUS.SKIP),
      details: routeHealth.missingRoute ? `Missing route: ${routeHealth.missingRoute}` : (routeHealth.checked ? 'Agent route table resolved selected tool/action.' : 'Agent route proof not attached.'),
      evidence: routeHealth,
    }),
    node({
      id: 'runtime_no_uncaught_errors',
      label: 'No uncaught runtime errors',
      lane: LANES.UI_EVENT,
      status: runtimeErrors.length ? STATUS.FAIL : STATUS.PASS,
      details: runtimeErrors.length ? `${runtimeErrors.length} runtime error(s) captured.` : 'No runtime errors captured by this panel.',
      evidence: runtimeErrors.slice(0, 20),
    }),
  ];

  const edges = [
    edge('relay_server_started', 'relay_port_matches_extension'),
    edge('relay_port_matches_extension', 'relay_extension_connected'),
    edge('relay_extension_connected', 'relay_enabled_tab_exists'),
    edge('relay_server_started', 'relay_cdp_port_not_conflicting'),
    edge('relay_enabled_tab_exists', 'relay_action_roundtrip'),
    edge('relay_cdp_port_not_conflicting', 'relay_action_roundtrip'),
    edge('ui_buttons_have_handlers', 'ui_no_recent_misfire'),
  ];

  const hiddenBreakers = computeHiddenBreakers(nodes, { relay, uiHealth, routeHealth, runtimeErrors });
  const summary = summarizeNodes(nodes);

  return { nodes, edges, lanes: Object.values(LANES), hiddenBreakers, summary, timestamp: new Date().toISOString() };
}

export function summarizeNodes(nodes) {
  return nodes.reduce((acc, n) => {
    acc.total += 1;
    acc[n.status] = (acc[n.status] || 0) + 1;
    if (n.status === STATUS.FAIL || n.status === STATUS.WARN) acc.problemNodes.push(n.id);
    return acc;
  }, { total: 0, PASS: 0, WARN: 0, FAIL: 0, SKIP: 0, problemNodes: [] });
}

export function computeHiddenBreakers(nodes, context = {}) {
  const breakers = [];
  for (const n of nodes) {
    if (n.status !== STATUS.FAIL && n.status !== STATUS.WARN) continue;
    breakers.push({
      id: n.id,
      severity: n.status,
      lane: n.lane,
      label: n.label,
      details: n.details,
      evidence: n.evidence,
    });
  }

  for (const err of context.runtimeErrors || []) {
    breakers.push({
      id: `runtime_error_${breakers.length + 1}`,
      severity: STATUS.FAIL,
      lane: LANES.UI_EVENT,
      label: err.name || err.type || 'Runtime error',
      details: err.message || String(err),
      evidence: err,
    });
  }

  return breakers;
}
