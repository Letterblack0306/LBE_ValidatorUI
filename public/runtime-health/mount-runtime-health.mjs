// Single import entrypoint for the UI.
// Usage:
//   import './runtime-health/runtime-health.css'; // if your bundler supports CSS imports
//   import { mountRuntimeHealthPanel } from './runtime-health/mount-runtime-health.mjs';
//   mountRuntimeHealthPanel('#runtime-health-root', { expectedRelayPort: 4424, autoRefreshMs: 3000 });

export { mountRuntimeHealthPanel, renderRuntimeHealthPanel } from './RuntimeHealthPanel.mjs';
export { collectRuntimeHealth, reportUiMisfire, scanUiWiring } from './runtime-health-adapter.mjs';
export { buildRuntimeProofGraph, LANES, STATUS } from './runtime-health-schema.mjs';
