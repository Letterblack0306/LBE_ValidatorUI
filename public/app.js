import { mountRuntimeHealthPanel } from './runtime-health/mount-runtime-health.mjs';

async function api(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = `${res.status}: ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) {
        detail = body.error;
        if (body.checkedPaths?.length) {
          detail += '\n\nLooked for summary.json at:\n' + body.checkedPaths.join('\n');
        }
      }
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}

const state = {
  projects: [],
  currentProjectId: null,
  currentCustomPath: null,
  bundle: null,
  nodes: [],
  edges: [],
  filteredNodes: [],
  positions: new Map(),
  selectedId: null,
  zoom: 1,
  pan: { x: 120, y: 80 },
  dragging: false,
  dragStart: null,
  autoTimer: null
};

const el = {
  projectList: document.getElementById('projectList'),
  refreshBtn: document.getElementById('refreshBtn'),
  resetViewBtn: document.getElementById('resetViewBtn'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomReadout: document.getElementById('zoomReadout'),
  autoRefresh: document.getElementById('autoRefresh'),
  projectTitle: document.getElementById('projectTitle'),
  projectMeta: document.getElementById('projectMeta'),
  statusPill: document.getElementById('statusPill'),
  metricStatus: document.getElementById('metricStatus'),
  metricRun: document.getElementById('metricRun'),
  metricSource: document.getElementById('metricSource'),
  metricPublic: document.getElementById('metricPublic'),
  viewport: document.getElementById('canvasViewport'),
  surface: document.getElementById('canvasSurface'),
  edgeLayer: document.getElementById('edgeLayer'),
  nodeLayer: document.getElementById('nodeLayer'),
  filterInput: document.getElementById('filterInput'),
  detailsEmpty: document.getElementById('detailsEmpty'),
  detailsContent: document.getElementById('detailsContent'),
  nodeTableBody: document.querySelector('#nodeTable tbody'),
  rowCount: document.getElementById('rowCount'),
  customPathInput: document.getElementById('customPathInput'),
  loadCustomBtn: document.getElementById('loadCustomBtn'),
  saveProjectBtn: document.getElementById('saveProjectBtn'),
  pathSuggestions: document.getElementById('pathSuggestions'),
  summaryGrid: document.querySelector('.summary-grid'),
  workspace: document.querySelector('.workspace'),
  tablePanel: document.querySelector('.table-panel'),
  viewProofBtn: document.getElementById('viewProofBtn'),
  viewHealthBtn: document.getElementById('viewHealthBtn'),
  runtimeHealthRoot: document.getElementById('runtime-health-root')
};

function statusClass(status) {
  const s = String(status || '').toUpperCase();
  if (['PASS', 'READY', 'OK', 'SUCCESS'].includes(s)) return 'pass';
  if (['FAIL', 'FAILED', 'BLOCKED', 'ERROR'].includes(s)) return 'fail';
  if (['WARN', 'WARNING', 'UNKNOWN'].includes(s)) return 'warn';
  return 'pending';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function truncate(value, max = 56) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function loadProjects() {
  const params = new URLSearchParams(window.location.search);
  const customPath = params.get('path');

  const data = await api('/api/projects');
  state.projects = data.projects || [];
  
  if (customPath) {
    state.currentProjectId = 'custom';
    state.currentCustomPath = customPath;
    await loadProject('custom', customPath);
  } else {
    renderProjects();
    if (!state.currentProjectId && state.projects.length) {
      state.currentProjectId = state.projects[0].id;
    }
    if (state.currentProjectId) await loadProject(state.currentProjectId);
  }
}

function renderProjects() {
  el.projectList.innerHTML = state.projects.map((project) => {
    const active = project.id === state.currentProjectId ? ' active' : '';
    const status = project.error ? 'ERROR' : (project.status || 'UNKNOWN');
    const isCustom = project.id === 'custom';
    return `<div class="project-item-wrap">
      <button class="project-item${active}" data-project-id="${escapeHtml(project.id)}" data-custom-path="${escapeHtml(project.customPath || '')}">
        <strong>${escapeHtml(project.name)}</strong>
        <span>${escapeHtml(status)} · ${escapeHtml(project.runId || 'no run')}</span>
        <span>${escapeHtml(project.root || '')}</span>
      </button>
      ${!isCustom ? `<button class="btn-remove-project" data-remove-id="${escapeHtml(project.id)}" title="Remove project">×</button>` : ''}
    </div>`;
  }).join('');
}

async function saveCurrentAsProject() {
  const bundle = state.bundle;
  if (!bundle) return;
  const defaultName = bundle.project.name || '';
  const name = prompt('Project name:', defaultName);
  if (!name || !name.trim()) return;
  try {
    const res = await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), root: bundle.project.root })
    });
    // Replace the ephemeral custom entry with the saved one
    const idx = state.projects.findIndex((p) => p.id === 'custom');
    const saved = { id: res.id, name: res.name, root: res.root, status: bundle.summary.status, runId: bundle.summary.runId };
    if (idx !== -1) state.projects.splice(idx, 1, saved); else state.projects.push(saved);
    state.currentProjectId = res.id;
    state.currentCustomPath = null;
    el.customPathInput.value = '';
    renderProjects();
    updateSaveBtn();
  } catch (err) {
    alert(`Could not save project: ${err.message}`);
  }
}

function updateSaveBtn() {
  const show = state.currentProjectId === 'custom' && !!state.bundle;
  el.saveProjectBtn.style.display = show ? '' : 'none';
}

async function loadProject(id, customPath = null) {
  state.currentProjectId = id;
  state.currentCustomPath = customPath;

  const url = customPath
    ? `/api/project?path=${encodeURIComponent(customPath)}`
    : `/api/project?id=${encodeURIComponent(id)}`;

  const bundle = await api(url);
  state.bundle = bundle;

  if (customPath) {
    const existing = state.projects.find((p) => p.id === 'custom');
    const customProject = {
      id: 'custom',
      name: bundle.project.name,
      root: bundle.project.root,
      status: bundle.summary.status,
      runId: bundle.summary.runId,
      truth: bundle.project.truth,
      customPath: customPath
    };
    if (existing) {
      Object.assign(existing, customProject);
    } else {
      state.projects.unshift(customProject);
    }
  }

  renderSummary();
  renderProjects();
  updateSaveBtn();
  state.nodes = bundle.graph?.nodes || [];
  state.edges = bundle.graph?.edges || [];
  state.selectedId = null;
  state.positions = layoutNodes(state.nodes, state.edges);
  applyFilter();
  resetView(false);
  renderAll();
}

function layoutNodes(nodes, edges) {
  const positions = new Map();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));

  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const queue = nodes.filter((n) => (incoming.get(n.id) || 0) === 0).map((n) => n.id);
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    seen.add(id);
    for (const next of outgoing.get(id) || []) {
      depth.set(next, Math.max(depth.get(next) || 0, (depth.get(id) || 0) + 1));
      incoming.set(next, (incoming.get(next) || 1) - 1);
      if ((incoming.get(next) || 0) === 0) queue.push(next);
    }
  }

  for (const n of nodes) {
    if (!seen.has(n.id) && !depth.has(n.id)) depth.set(n.id, 0);
  }

  const columns = new Map();
  for (const node of nodes) {
    const d = depth.get(node.id) || 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(node);
  }

  const colW = 340;
  const rowH = 172;
  const startX = 160;
  const startY = 120;
  for (const [d, colNodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    colNodes.sort((a, b) => {
      const ar = statusClass(a.status);
      const br = statusClass(b.status);
      if (ar !== br) return ar.localeCompare(br);
      return String(a.label).localeCompare(String(b.label));
    });
    colNodes.forEach((node, row) => {
      positions.set(node.id, { x: startX + d * colW, y: startY + row * rowH });
    });
  }

  return positions;
}

function renderSummary() {
  const summary = state.bundle?.summary || {};
  const project = state.bundle?.project || {};
  const status = summary.status || 'UNKNOWN';
  const cls = statusClass(status);

  el.projectTitle.textContent = project.name || summary.project || 'Project';
  el.projectMeta.textContent = `${project.root || 'no root'} · ${project.truth || 'no truth path'}`;
  el.statusPill.textContent = status;
  el.statusPill.className = `status-pill ${cls}`;
  el.metricStatus.textContent = status;
  el.metricRun.textContent = summary.runId || '—';
  el.metricSource.textContent = summary.sourceHead || summary.head || '—';
  el.metricPublic.textContent = summary.publicHead || summary.remoteHead || '—';
}

function applyFilter() {
  const q = el.filterInput.value.trim().toLowerCase();
  if (!q) {
    state.filteredNodes = [...state.nodes];
    return;
  }
  state.filteredNodes = state.nodes.filter((node) => {
    const haystack = [node.id, node.label, node.status, node.parent, node.targetAction, node.type, JSON.stringify(node.evidence || '')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function visibleNodeIds() {
  return new Set(state.filteredNodes.map((n) => n.id));
}

function renderAll() {
  renderCanvas();
  renderTable();
  renderDetails();
  updateTransform();
}

function renderCanvas() {
  const visible = visibleNodeIds();
  const nodes = state.filteredNodes;
  const edges = state.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));

  el.nodeLayer.innerHTML = nodes.map((node) => {
    const pos = state.positions.get(node.id) || { x: 100, y: 100 };
    const cls = statusClass(node.status);
    const selected = state.selectedId === node.id ? ' selected' : '';
    return `<div class="node ${cls}${selected}" data-node-id="${escapeHtml(node.id)}" style="left:${pos.x}px;top:${pos.y}px">
      <div class="node-header">
        <div>
          <div class="node-title">${escapeHtml(node.label || node.id)}</div>
          <div class="node-id">${escapeHtml(node.id)}</div>
        </div>
        <div class="node-status ${cls}">${escapeHtml(node.status || 'UNKNOWN')}</div>
      </div>
      <div class="node-meta">
        <div><b>Parent:</b> ${escapeHtml(node.parent || 'empty')}</div>
        <div><b>Target:</b> ${escapeHtml(node.targetAction || 'empty')}</div>
        <div><b>Type:</b> ${escapeHtml(node.type || 'module')}</div>
      </div>
    </div>`;
  }).join('');

  el.edgeLayer.innerHTML = edges.map((edge) => {
    const a = state.positions.get(edge.from);
    const b = state.positions.get(edge.to);
    if (!a || !b) return '';
    const cls = `${statusClass(edge.status)} ${edge.type || ''}`.trim();
    const x1 = a.x + 260;
    const y1 = a.y + 62;
    const x2 = b.x;
    const y2 = b.y + 62;
    const dx = Math.max(80, Math.abs(x2 - x1) * 0.45);
    const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    return `<path class="edge-path ${escapeHtml(cls)}" d="${path}" marker-end="url(#arrow)" />`;
  }).join('');

  const defs = `<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(148,163,184,0.8)"></path>
    </marker>
  </defs>`;
  el.edgeLayer.insertAdjacentHTML('afterbegin', defs);
}

function renderTable() {
  const rows = state.filteredNodes;
  el.rowCount.textContent = `${rows.length} rows`;
  el.nodeTableBody.innerHTML = rows.map((node) => {
    const cls = statusClass(node.status);
    const selected = state.selectedId === node.id ? ' selected' : '';
    const evidence = Array.isArray(node.evidence) ? node.evidence.join(', ') : (node.evidence || '');
    return `<tr class="${selected}" data-node-id="${escapeHtml(node.id)}">
      <td class="status-cell ${cls}">${escapeHtml(node.status || 'UNKNOWN')}</td>
      <td>${escapeHtml(node.id)}</td>
      <td>${escapeHtml(node.label || '')}</td>
      <td>${escapeHtml(node.parent || '')}</td>
      <td>${escapeHtml(node.targetAction || '')}</td>
      <td>${escapeHtml(truncate(evidence, 90))}</td>
    </tr>`;
  }).join('');
}

function renderDetails() {
  const node = state.nodes.find((n) => n.id === state.selectedId);
  if (!node) {
    el.detailsEmpty.classList.remove('hidden');
    el.detailsContent.classList.add('hidden');
    el.detailsContent.innerHTML = '';
    return;
  }

  const summary = state.bundle?.summary || {};
  const runFiles = state.bundle?.runFiles || {};
  const evidence = Array.isArray(node.evidence) ? node.evidence : (node.evidence ? [node.evidence] : []);

  const evidenceBlocks = evidence.map((item) => {
    const key = String(item).split('#')[0];
    const match = runFiles[key];
    if (!match) {
      return `<div class="detail-card"><div class="detail-row"><span>Evidence</span><div>${escapeHtml(item)}</div></div></div>`;
    }
    return `<div class="detail-card">
      <div class="detail-row"><span>Evidence</span><div>${escapeHtml(item)}</div></div>
      <div class="detail-row"><span>File size</span><div>${escapeHtml(match.size)} bytes</div></div>
      <pre>${escapeHtml(match.content)}</pre>
    </div>`;
  }).join('');

  el.detailsEmpty.classList.add('hidden');
  el.detailsContent.classList.remove('hidden');
  el.detailsContent.innerHTML = `
    <div class="detail-card">
      <div class="detail-row"><span>Status</span><div class="status-cell ${statusClass(node.status)}">${escapeHtml(node.status)}</div></div>
      <div class="detail-row"><span>ID</span><div>${escapeHtml(node.id)}</div></div>
      <div class="detail-row"><span>Label</span><div>${escapeHtml(node.label)}</div></div>
      <div class="detail-row"><span>Type</span><div>${escapeHtml(node.type)}</div></div>
      <div class="detail-row"><span>Parent</span><div>${escapeHtml(node.parent || 'empty')}</div></div>
      <div class="detail-row"><span>Target</span><div>${escapeHtml(node.targetAction || 'empty')}</div></div>
      <div class="detail-row"><span>Run ID</span><div>${escapeHtml(summary.runId || '')}</div></div>
      <div class="detail-row"><span>Date</span><div>${escapeHtml(summary.finishedAt || summary.startedAt || '')}</div></div>
      <div class="detail-row"><span>Repo</span><div>${escapeHtml(summary.repo || '')}</div></div>
    </div>
    ${evidenceBlocks}
    <div class="detail-card">
      <div class="section-title">Raw node JSON</div>
      <pre>${escapeHtml(JSON.stringify(node.raw, null, 2))}</pre>
    </div>
  `;
}

function selectNode(id) {
  state.selectedId = id;
  renderCanvas();
  renderTable();
  renderDetails();
}

function updateTransform() {
  el.surface.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  el.zoomReadout.textContent = `${Math.round(state.zoom * 100)}%`;
}

function zoomAt(delta, center = null) {
  const oldZoom = state.zoom;
  const next = Math.min(2.5, Math.max(0.25, oldZoom + delta));
  if (next === oldZoom) return;

  const rect = el.viewport.getBoundingClientRect();
  const cx = center?.x ?? rect.width / 2;
  const cy = center?.y ?? rect.height / 2;
  const worldX = (cx - state.pan.x) / oldZoom;
  const worldY = (cy - state.pan.y) / oldZoom;
  state.zoom = next;
  state.pan.x = cx - worldX * next;
  state.pan.y = cy - worldY * next;
  updateTransform();
}

function resetView(render = true) {
  state.zoom = 1;
  state.pan = { x: 50, y: 40 };
  if (render) updateTransform();
}

function setHeaderLoading(name) {
  el.projectTitle.textContent = name || 'Loading…';
  el.projectMeta.textContent = 'Loading project data…';
  el.statusPill.textContent = '…';
  el.statusPill.className = 'status-pill pending';
  el.metricStatus.textContent = '—';
  el.metricRun.textContent = '—';
  el.metricSource.textContent = '—';
  el.metricPublic.textContent = '—';
}

function setHeaderError(name, message) {
  el.projectTitle.textContent = name || 'Error';
  el.projectMeta.textContent = message;
  el.statusPill.textContent = 'ERROR';
  el.statusPill.className = 'status-pill fail';
  el.metricStatus.textContent = 'ERROR';
}

function attachEvents() {
  el.projectList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-project-id]');
    if (!button) return;
    const customPath = button.dataset.customPath || null;
    const projectName = button.querySelector('strong')?.textContent || button.dataset.projectId;
    setHeaderLoading(projectName);
    try {
      await loadProject(button.dataset.projectId, customPath);
    } catch (err) {
      setHeaderError(projectName, err.message);
      console.error(err);
    }
  });

  el.refreshBtn.addEventListener('click', async () => {
    if (!state.currentProjectId) return;
    setHeaderLoading(state.bundle?.project?.name);
    try {
      await loadProject(state.currentProjectId, state.currentCustomPath);
    } catch (err) {
      setHeaderError(state.bundle?.project?.name, err.message);
      console.error(err);
    }
  });

  el.loadCustomBtn.addEventListener('click', async () => {
    const customPath = el.customPathInput.value.trim();
    if (!customPath) return;
    try {
      await loadProject('custom', customPath);
    } catch (err) {
      alert(`Failed to load custom project path:\n${err.message}`);
    }
  });

  let suggestTimer = null;
  let activeSuggestion = -1;

  function hideSuggestions() {
    el.pathSuggestions.classList.add('hidden');
    el.pathSuggestions.innerHTML = '';
    activeSuggestion = -1;
  }

  function showSuggestions(dirs) {
    if (!dirs.length) { hideSuggestions(); return; }
    activeSuggestion = -1;
    el.pathSuggestions.innerHTML = dirs.map((d, i) =>
      `<div class="path-suggestion" data-idx="${i}" data-path="${escapeHtml(d)}">${escapeHtml(d)}</div>`
    ).join('');
    el.pathSuggestions.classList.remove('hidden');
  }

  el.pathSuggestions.addEventListener('mousedown', async (e) => {
    const item = e.target.closest('[data-path]');
    if (!item) return;
    e.preventDefault();
    el.customPathInput.value = item.dataset.path;
    hideSuggestions();
    fetchSuggestions(item.dataset.path + '/');
  });

  async function fetchSuggestions(val) {
    try {
      const data = await api(`/api/fs/dirs?path=${encodeURIComponent(val)}`);
      showSuggestions(data.dirs || []);
    } catch { hideSuggestions(); }
  }

  el.customPathInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const val = el.customPathInput.value;
    if (!val) { hideSuggestions(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(val), 120);
  });

  el.customPathInput.addEventListener('focus', () => {
    const val = el.customPathInput.value;
    if (val) fetchSuggestions(val);
    else fetchSuggestions('');
  });

  el.customPathInput.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 150);
  });

  el.customPathInput.addEventListener('keydown', async (event) => {
    const items = el.pathSuggestions.querySelectorAll('.path-suggestion');
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeSuggestion = Math.min(activeSuggestion + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === activeSuggestion));
      if (items[activeSuggestion]) el.customPathInput.value = items[activeSuggestion].dataset.path;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === activeSuggestion));
      if (items[activeSuggestion]) el.customPathInput.value = items[activeSuggestion].dataset.path;
      return;
    }
    if (event.key === 'Tab' && !el.pathSuggestions.classList.contains('hidden')) {
      event.preventDefault();
      const first = items[activeSuggestion >= 0 ? activeSuggestion : 0];
      if (first) { el.customPathInput.value = first.dataset.path; fetchSuggestions(first.dataset.path + '/'); }
      return;
    }
    if (event.key === 'Enter') {
      const customPath = el.customPathInput.value.trim();
      if (!customPath) return;
      try {
        await loadProject('custom', customPath);
      } catch (err) {
        alert(`Failed to load custom project path:\n${err.message}`);
      }
    }
  });

  el.resetViewBtn.addEventListener('click', () => resetView(true));
  el.zoomInBtn.addEventListener('click', () => zoomAt(0.1));
  el.zoomOutBtn.addEventListener('click', () => zoomAt(-0.1));

  el.filterInput.addEventListener('input', () => {
    applyFilter();
    renderAll();
  });

  el.nodeLayer.addEventListener('click', (event) => {
    const node = event.target.closest('[data-node-id]');
    if (!node) return;
    selectNode(node.dataset.nodeId);
  });

  el.nodeTableBody.addEventListener('click', (event) => {
    const row = event.target.closest('[data-node-id]');
    if (!row) return;
    selectNode(row.dataset.nodeId);
  });

  el.viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = el.viewport.getBoundingClientRect();
    const delta = event.deltaY > 0 ? -0.08 : 0.08;
    zoomAt(delta, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });

  el.viewport.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.node')) return;
    state.dragging = true;
    state.dragStart = { x: event.clientX, y: event.clientY, panX: state.pan.x, panY: state.pan.y };
    el.viewport.setPointerCapture(event.pointerId);
    el.viewport.classList.add('dragging');
  });

  el.viewport.addEventListener('pointermove', (event) => {
    if (!state.dragging || !state.dragStart) return;
    state.pan.x = state.dragStart.panX + event.clientX - state.dragStart.x;
    state.pan.y = state.dragStart.panY + event.clientY - state.dragStart.y;
    updateTransform();
  });

  el.viewport.addEventListener('pointerup', (event) => {
    state.dragging = false;
    state.dragStart = null;
    el.viewport.releasePointerCapture?.(event.pointerId);
    el.viewport.classList.remove('dragging');
  });

  el.saveProjectBtn.addEventListener('click', saveCurrentAsProject);

  el.projectList.addEventListener('click', async (event) => {
    const removeBtn = event.target.closest('[data-remove-id]');
    if (!removeBtn) return;
    event.stopPropagation();
    const id = removeBtn.dataset.removeId;
    if (!confirm(`Remove project "${id}" from the list?`)) return;
    try {
      await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.projects = state.projects.filter((p) => p.id !== id);
      if (state.currentProjectId === id) {
        state.currentProjectId = state.projects[0]?.id || null;
        state.currentCustomPath = null;
        if (state.currentProjectId) await loadProject(state.currentProjectId);
        else renderProjects();
      } else {
        renderProjects();
      }
    } catch (err) {
      alert(`Could not remove project: ${err.message}`);
    }
  }, true);

  el.autoRefresh.addEventListener('change', () => {
    if (state.autoTimer) clearInterval(state.autoTimer);
    state.autoTimer = null;
    if (el.autoRefresh.checked) {
      state.autoTimer = setInterval(async () => {
        if (state.currentProjectId) {
          try { await loadProject(state.currentProjectId, state.currentCustomPath); } catch (err) { console.error(err); }
        }
      }, 5000);
    }
  });

  el.viewProofBtn.addEventListener('click', () => switchView('proof'));
  el.viewHealthBtn.addEventListener('click', () => switchView('health'));
}

function switchView(viewName) {
  if (viewName === 'proof') {
    el.viewProofBtn.classList.add('primary');
    el.viewHealthBtn.classList.remove('primary');
    el.summaryGrid.classList.remove('hidden');
    el.workspace.classList.remove('hidden');
    el.tablePanel.classList.remove('hidden');
    el.runtimeHealthRoot.classList.add('hidden');
  } else if (viewName === 'health') {
    el.viewProofBtn.classList.remove('primary');
    el.viewHealthBtn.classList.add('primary');
    el.summaryGrid.classList.add('hidden');
    el.workspace.classList.add('hidden');
    el.tablePanel.classList.add('hidden');
    el.runtimeHealthRoot.classList.remove('hidden');
  }
}

async function main() {
  attachEvents();
  updateTransform();
  try {
    mountRuntimeHealthPanel(el.runtimeHealthRoot, {
      expectedRelayPort: 4424,
      autoRefreshMs: 3000
    });
    await loadProjects();
  } catch (err) {
    el.projectTitle.textContent = 'Failed to load Truth Console';
    el.projectMeta.textContent = err.message;
    console.error(err);
  }
}

main();
