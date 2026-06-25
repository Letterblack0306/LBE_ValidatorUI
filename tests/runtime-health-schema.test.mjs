import assert from 'node:assert/strict';
import { buildRuntimeProofGraph } from '../public/runtime-health/runtime-health-schema.mjs';

{
  const graph = buildRuntimeProofGraph({
    expectedRelayPort: 4424,
    extensionRelayUrl: 'http://127.0.0.1:4424',
    relayStatus: { ok: true, running: true, connected: false, port: 7332, tabCount: 0 },
  });
  const portNode = graph.nodes.find((n) => n.id === 'relay_port_matches_extension');
  assert.equal(portNode.status, 'FAIL');
  assert.match(portNode.details, /7332/);
  assert.match(portNode.details, /4424/);
}

{
  const graph = buildRuntimeProofGraph({
    expectedRelayPort: 4424,
    relayStatus: { ok: true, running: true, connected: true, port: 4424, tabCount: 0 },
  });
  assert.equal(graph.nodes.find((n) => n.id === 'relay_server_started').status, 'PASS');
  assert.equal(graph.nodes.find((n) => n.id === 'relay_extension_connected').status, 'PASS');
  assert.equal(graph.nodes.find((n) => n.id === 'relay_enabled_tab_exists').status, 'WARN');
}

{
  const graph = buildRuntimeProofGraph({
    expectedRelayPort: 4424,
    relayStatus: { ok: true, running: true, connected: true, port: 4424, tabCount: 1, cdpPort: 4424, portConflict: true },
  });
  assert.equal(graph.nodes.find((n) => n.id === 'relay_cdp_port_not_conflicting').status, 'FAIL');
}

console.log('runtime-health-schema.test.mjs passed');
