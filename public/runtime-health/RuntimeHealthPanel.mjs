// Vanilla UI renderer for Runtime Health graph.
// No framework dependency.

import { collectRuntimeHealth } from './runtime-health-adapter.mjs';

const STATUS_ORDER = ['FAIL', 'WARN', 'PASS', 'SKIP'];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function statusRank(status) {
  const idx = STATUS_ORDER.indexOf(status);
  return idx === -1 ? STATUS_ORDER.length : idx;
}

function groupByLane(graph) {
  const lanes = new Map();
  for (const lane of graph.lanes || []) lanes.set(lane, []);
  for (const n of graph.nodes || []) {
    if (!lanes.has(n.lane)) lanes.set(n.lane, []);
    lanes.get(n.lane).push(n);
  }
  return lanes;
}

function renderSummary(summary = {}) {
  return `
    <div class="rh-summary-card rh-status-fail"><strong>${summary.FAIL || 0}</strong><span>Fail</span></div>
    <div class="rh-summary-card rh-status-warn"><strong>${summary.WARN || 0}</strong><span>Warn</span></div>
    <div class="rh-summary-card rh-status-pass"><strong>${summary.PASS || 0}</strong><span>Pass</span></div>
    <div class="rh-summary-card rh-status-skip"><strong>${summary.SKIP || 0}</strong><span>Skip</span></div>
  `;
}

function renderNode(node) {
  const deps = node.dependsOn?.length ? `<div class="rh-node-deps">depends: ${escapeHtml(node.dependsOn.join(', '))}</div>` : '';
  return `
    <button class="rh-node rh-status-${escapeHtml(node.status).toLowerCase()}" data-node-id="${escapeHtml(node.id)}" type="button">
      <span class="rh-node-top"><span>${escapeHtml(node.label)}</span><b>${escapeHtml(node.status)}</b></span>
      <span class="rh-node-id">${escapeHtml(node.id)}</span>
      <span class="rh-node-details">${escapeHtml(node.details)}</span>
      ${deps}
    </button>
  `;
}

function renderLanes(graph) {
  const lanes = groupByLane(graph);
  return [...lanes.entries()].map(([lane, nodes]) => {
    const sorted = [...nodes].sort((a, b) => statusRank(a.status) - statusRank(b.status));
    return `
      <section class="rh-lane">
        <header class="rh-lane-header">
          <h4>${escapeHtml(lane)}</h4>
          <span>${sorted.length} node${sorted.length === 1 ? '' : 's'}</span>
        </header>
        <div class="rh-node-stack">
          ${sorted.length ? sorted.map(renderNode).join('') : '<div class="rh-empty">No nodes attached.</div>'}
        </div>
      </section>
    `;
  }).join('');
}

function renderBreakers(graph) {
  const breakers = graph.hiddenBreakers || [];
  if (!breakers.length) return '<div class="rh-empty">No hidden breakers detected by current probes.</div>';
  return breakers.map((b) => `
    <button class="rh-breaker rh-status-${escapeHtml(b.severity).toLowerCase()}" data-node-id="${escapeHtml(b.id)}" data-breaker-id="${escapeHtml(b.id)}" type="button">
      <b>${escapeHtml(b.severity)}</b>
      <span>${escapeHtml(b.label)}</span>
      <small>${escapeHtml(b.lane)} — ${escapeHtml(b.details)}</small>
    </button>
  `).join('');
}

function renderDetails(selected) {
  if (!selected) {
    return `<div class="rh-details-empty">Select a node to inspect evidence.</div>`;
  }

  return `
    <div class="rh-details-title">
      <b>${escapeHtml(selected.label || selected.id)}</b>
      <span class="rh-pill rh-status-${escapeHtml(selected.status || selected.severity || 'skip').toLowerCase()}">${escapeHtml(selected.status || selected.severity || 'INFO')}</span>
    </div>
    <p>${escapeHtml(selected.details || '')}</p>
    <pre>${escapeHtml(JSON.stringify(selected.evidence ?? selected, null, 2))}</pre>
  `;
}

export function renderRuntimeHealthPanel(container, graph, state = {}) {
  const selectedId = state.selectedId;
  const selected = (graph.nodes || []).find((n) => n.id === selectedId)
    || (graph.hiddenBreakers || []).find((b) => b.id === selectedId)
    || null;

  container.innerHTML = `
    <div class="runtime-health-panel">
      <header class="rh-header">
        <div>
          <h3>Runtime Health</h3>
          <p>Shows connected runtime modules, hidden breakers, relay state, UI wiring, and route evidence.</p>
        </div>
        <div class="rh-actions">
          <span class="rh-timestamp">${escapeHtml(graph.timestamp || '')}</span>
          <button class="rh-refresh" type="button" data-rh-refresh>Refresh</button>
        </div>
      </header>

      <section class="rh-summary">${renderSummary(graph.summary)}</section>

      <main class="rh-grid">
        <section class="rh-lanes">${renderLanes(graph)}</section>
        <aside class="rh-side">
          <section class="rh-card">
            <header><h4>Hidden Breakers</h4></header>
            <div class="rh-breaker-list">${renderBreakers(graph)}</div>
          </section>
          <section class="rh-card rh-details">
            <header><h4>Evidence</h4></header>
            ${renderDetails(selected)}
          </section>
        </aside>
      </main>
    </div>
  `;
}

export function mountRuntimeHealthPanel(target, options = {}) {
  const container = typeof target === 'string' ? document.querySelector(target) : target;
  if (!container) throw new Error('RuntimeHealthPanel target not found.');

  const state = { selectedId: null, graph: null, timer: null };

  async function refresh() {
    container.classList.add('rh-loading');
    try {
      state.graph = await collectRuntimeHealth({ ...options, root: options.root || document });
      renderRuntimeHealthPanel(container, state.graph, state);
    } catch (error) {
      container.innerHTML = `
        <div class="runtime-health-panel rh-fatal">
          <h3>Runtime Health failed to render</h3>
          <pre>${escapeHtml(error?.stack || error?.message || String(error))}</pre>
        </div>`;
    } finally {
      container.classList.remove('rh-loading');
    }
  }

  container.addEventListener('click', (event) => {
    const refreshButton = event.target.closest?.('[data-rh-refresh]');
    if (refreshButton) {
      refresh();
      return;
    }

    const nodeButton = event.target.closest?.('[data-node-id]');
    if (nodeButton && state.graph) {
      state.selectedId = nodeButton.dataset.nodeId;
      renderRuntimeHealthPanel(container, state.graph, state);
    }
  });

  refresh();

  if (options.autoRefreshMs && Number(options.autoRefreshMs) >= 1000) {
    state.timer = setInterval(refresh, Number(options.autoRefreshMs));
  }

  return {
    refresh,
    destroy() {
      if (state.timer) clearInterval(state.timer);
      container.innerHTML = '';
    },
  };
}
