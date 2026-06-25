import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 7766);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config', 'projects.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function json(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function isSubPath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveMaybeRelative(value, baseDir = __dirname) {
  if (!value) return null;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

async function loadConfig() {
  const config = await readJson(CONFIG_PATH);
  const projects = Array.isArray(config.projects) ? config.projects : [];
  return projects.map((p, index) => {
    const root = resolveMaybeRelative(p.root, __dirname);
    const truth = p.truth ? resolveMaybeRelative(p.truth, __dirname) : null;
    return {
      id: p.id || `project-${index + 1}`,
      name: p.name || p.id || `Project ${index + 1}`,
      root,
      truth,
      raw: p
    };
  });
}

async function resolveTruthSummary(project) {
  if (project.truth && await exists(project.truth)) {
    return project.truth;
  }

  const latestRunPointer = path.join(project.root, '.truth', 'latest-run.json');
  if (await exists(latestRunPointer)) {
    const pointer = await readJson(latestRunPointer);
    const summaryValue = pointer.summary;
    if (summaryValue) {
      const candidate = path.isAbsolute(summaryValue)
        ? path.normalize(summaryValue)
        : path.resolve(project.root, summaryValue);
      if (await exists(candidate)) return candidate;
    }
    if (pointer.runId) {
      const candidate = path.join(project.root, '.truth', 'runs', pointer.runId, 'summary.json');
      if (await exists(candidate)) return candidate;
    }
  }

  const latestDirCandidate = path.join(project.root, '.truth', 'runs', 'latest', 'summary.json');
  if (await exists(latestDirCandidate)) return latestDirCandidate;

  const runsDir = path.join(project.root, '.truth', 'runs');
  if (await exists(runsDir)) {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const dir of dirs) {
      const candidate = path.join(runsDir, dir, 'summary.json');
      if (await exists(candidate)) return candidate;
    }
  }

  throw new Error(`No summary.json found for ${project.name}. Checked configured truth path, .truth/latest-run.json, and .truth/runs/*/summary.json.`);
}

function statusRank(status) {
  const s = String(status || '').toUpperCase();
  if (['FAIL', 'FAILED', 'BLOCKED', 'ERROR'].includes(s)) return 0;
  if (['WARN', 'WARNING', 'UNKNOWN'].includes(s)) return 1;
  if (['PENDING', 'SKIPPED'].includes(s)) return 2;
  if (['PASS', 'READY', 'OK', 'SUCCESS'].includes(s)) return 3;
  return 2;
}

function normalizeStatus(status) {
  const s = String(status || 'UNKNOWN').toUpperCase();
  if (['READY', 'OK', 'SUCCESS'].includes(s)) return 'PASS';
  if (['FAILED', 'ERROR'].includes(s)) return 'FAIL';
  if (['WARNING'].includes(s)) return 'WARN';
  return s;
}

function normalizeGraph(summary) {
  const modules = Array.isArray(summary.modules) ? summary.modules : [];
  const checks = Array.isArray(summary.checks) ? summary.checks : [];
  const source = modules.length > 0 ? modules : checks.map((check) => ({
    moduleId: check.id,
    label: check.label || check.name || check.id,
    type: 'check',
    parent: check.parent || null,
    targetAction: check.targetAction || null,
    connectedTo: check.connectedTo || {},
    status: check.status,
    evidence: check.evidence,
    rawCheck: check
  }));

  const nodes = source.map((item, index) => {
    const id = item.moduleId || item.id || item.name || `node-${index + 1}`;
    return {
      id,
      label: item.label || item.name || id,
      type: item.type || 'module',
      parent: item.parent || null,
      targetAction: item.targetAction || null,
      connectedTo: item.connectedTo || {},
      status: normalizeStatus(item.status),
      evidence: item.evidence || null,
      raw: item
    };
  });

  const ids = new Set(nodes.map((node) => node.id));
  const edges = [];
  for (const node of nodes) {
    const c = node.connectedTo || {};
    if (c.left && ids.has(c.left)) {
      edges.push({ from: c.left, to: node.id, type: 'left', status: node.status });
    }
    if (c.right && ids.has(c.right)) {
      edges.push({ from: node.id, to: c.right, type: 'right', status: node.status });
    }
    if (node.parent && ids.has(node.parent)) {
      edges.push({ from: node.parent, to: node.id, type: 'parent', status: node.status });
    }
  }

  // Add synthetic parent placeholders where a module declares a missing parent.
  const synthetic = [];
  for (const node of nodes) {
    if (node.parent && !ids.has(node.parent)) {
      const parentId = `missing-parent:${node.parent}`;
      if (!ids.has(parentId)) {
        ids.add(parentId);
        synthetic.push({
          id: parentId,
          label: `Missing parent: ${node.parent}`,
          type: 'missing_parent',
          parent: null,
          targetAction: null,
          connectedTo: {},
          status: 'FAIL',
          evidence: null,
          raw: { reason: 'Declared parent does not exist as a node in the proof summary.', declaredParent: node.parent }
        });
      }
      edges.push({ from: parentId, to: node.id, type: 'missing-parent', status: 'FAIL' });
    }
  }

  return { nodes: [...synthetic, ...nodes], edges };
}

async function readOptionalRunFiles(runDir) {
  const candidates = ['manifest.json', 'commands.jsonl', 'files.jsonl', 'hashes.jsonl', 'final-receipt.txt', 'release-public-tree.txt', 'public-clone-tree.txt'];
  const result = {};
  for (const file of candidates) {
    const filePath = path.join(runDir, file);
    if (await exists(filePath)) {
      const stat = await fs.stat(filePath);
      const maxBytes = 256 * 1024;
      let content = await fs.readFile(filePath, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > maxBytes) {
        content = content.slice(0, maxBytes) + '\n\n[TRUNCATED BY TRUTH CONSOLE VIEWER]';
      }
      result[file] = { path: filePath, size: stat.size, content };
    }
  }
  return result;
}

async function getProjectBundle(projectId) {
  const projects = await loadConfig();
  const project = projects.find((p) => p.id === projectId) || projects[0];
  if (!project) throw new Error('No projects configured. Add entries to config/projects.json.');

  const summaryPath = await resolveTruthSummary(project);
  const summary = await readJson(summaryPath);
  const runDir = path.dirname(summaryPath);
  const runFiles = await readOptionalRunFiles(runDir);
  const graph = normalizeGraph(summary);

  const checkCounts = graph.nodes.reduce((acc, node) => {
    const key = normalizeStatus(node.status);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    project: {
      id: project.id,
      name: project.name,
      root: project.root,
      truth: summaryPath
    },
    summary,
    graph,
    runFiles,
    meta: {
      runDir,
      loadedAt: new Date().toISOString(),
      checkCounts,
      worstRank: Math.min(...graph.nodes.map((node) => statusRank(node.status)))
    }
  };
}

async function listProjectsForApi() {
  const projects = await loadConfig();
  return Promise.all(projects.map(async (p) => {
    let status = 'UNKNOWN';
    let runId = null;
    let truth = p.truth;
    let error = null;
    try {
      truth = await resolveTruthSummary(p);
      const summary = await readJson(truth);
      status = summary.status || 'UNKNOWN';
      runId = summary.runId || null;
    } catch (err) {
      error = err.message;
    }
    return {
      id: p.id,
      name: p.name,
      root: p.root,
      truth,
      status,
      runId,
      error
    };
  }));
}

async function serveStatic(req, res, pathname) {
  let requestedPath = pathname === '/' ? '/index.html' : pathname;
  requestedPath = decodeURIComponent(requestedPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!isSubPath(filePath, PUBLIC_DIR)) return text(res, 403, 'Forbidden');

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch {
    text(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (pathname === '/api/projects') {
      return json(res, 200, { projects: await listProjectsForApi() });
    }

    if (pathname === '/api/project') {
      const id = requestUrl.searchParams.get('id') || undefined;
      return json(res, 200, await getProjectBundle(id));
    }

    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, now: new Date().toISOString(), config: CONFIG_PATH });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    return json(res, 500, {
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

server.listen(PORT, () => {
  console.log(`LetterBlack Truth Console running at http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
