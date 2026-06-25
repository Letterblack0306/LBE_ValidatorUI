#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_REQUIRED_README_SECTIONS = [
  'Install',
  'Usage',
  'Public Scope',
  'Security',
  'Support'
];

const DEFAULT_FORBIDDEN_PATTERNS = [
  '.env',
  'PRIVATE_KEY',
  'PUBLIC_REPO_TOKEN',
  'GITHUB_TOKEN=',
  'npm_token',
  'NPM_TOKEN',
  'SECRET=',
  'TOKEN=',
  'password=',
  'internal mechanism',
  'private repo',
  'Z:/',
  'G:/Developments',
  'H:/Brew_Repo',
  'C:/Users/prave',
  'C:\\Users\\prave'
];

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.svg', '.yml', '.yaml', '.toml', '.ini', '.rs', '.go', '.py', '.sh', '.bat', '.ps1', '.xml', '.csv', '.lock', '.map'
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.wasm', '.zip', '.gz', '.tgz', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.dylib', '.so'
]);

function nowIso() {
  return new Date().toISOString();
}

function safeRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function normalizeStatus(value) {
  const s = String(value || '').toUpperCase();
  if (['PASS', 'READY', 'OK', 'SUCCESS'].includes(s)) return 'PASS';
  if (['FAIL', 'FAILED', 'BLOCKED', 'ERROR'].includes(s)) return 'FAIL';
  if (['WARN', 'WARNING', 'UNKNOWN'].includes(s)) return 'WARN';
  return 'PENDING';
}

function statusToSeverity(status) {
  const s = normalizeStatus(status);
  if (s === 'FAIL') return 3;
  if (s === 'WARN') return 2;
  if (s === 'PENDING') return 1;
  return 0;
}

function computeFinalStatus(checks) {
  const worst = checks.reduce((max, check) => Math.max(max, statusToSeverity(check.status)), 0);
  if (worst >= 3) return 'BLOCKED';
  if (worst >= 2) return 'UNKNOWN';
  if (worst >= 1) return 'UNKNOWN';
  return 'READY';
}

function splitCommand(command) {
  if (Array.isArray(command)) return command;
  if (!command || typeof command !== 'string') return [];
  const out = [];
  let current = '';
  let quote = null;
  let escape = false;
  for (const ch of command) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function relPath(filePath, root) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      args[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function mergeConfig(base, args) {
  const cli = {};
  if (args.root) cli.root = args.root;
  if (args.project) cli.project = args.project;
  if (args['release-dir']) cli.releaseDir = args['release-dir'];
  if (args['public-repo']) cli.publicRepo = args['public-repo'];
  if (args.build) cli.buildCommand = args.build;
  if (args['no-build']) cli.buildCommand = null;
  if (args['required-readme']) cli.requiredReadmeSections = String(args['required-readme']).split(',').map((s) => s.trim()).filter(Boolean);
  if (args.forbidden) cli.forbiddenPatterns = String(args.forbidden).split(',').map((s) => s.trim()).filter(Boolean);
  if (args['allow-dirty']) cli.allowDirty = true;
  if (args['max-scan-bytes']) cli.maxScanBytes = Number(args['max-scan-bytes']);
  if (args['timeout-ms']) cli.commandTimeoutMs = Number(args['timeout-ms']);
  if (args['build-timeout-ms']) cli.buildTimeoutMs = Number(args['build-timeout-ms']);
  if (args['clone-timeout-ms']) cli.cloneTimeoutMs = Number(args['clone-timeout-ms']);

  return {
    project: path.basename(process.cwd()),
    root: process.cwd(),
    releaseDir: 'release-public',
    publicRepo: process.env.PUBLIC_REPO_URL || null,
    buildCommand: null,
    requiredReadmeSections: DEFAULT_REQUIRED_README_SECTIONS,
    forbiddenPatterns: DEFAULT_FORBIDDEN_PATTERNS,
    allowDirty: false,
    maxScanBytes: 2_000_000,
    cloneDepth: 1,
    commandTimeoutMs: 120_000,
    buildTimeoutMs: 600_000,
    cloneTimeoutMs: 300_000,
    maxOutputBytes: 2_000_000,
    ...base,
    ...cli
  };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fssync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function appendJsonl(filePath, data) {
  await fs.appendFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}

class ProofSession {
  constructor(config) {
    this.config = config;
    this.root = path.resolve(config.root);
    this.releaseDir = path.resolve(this.root, config.releaseDir);
    this.startedAt = nowIso();
    this.runId = safeRunId(new Date());
    this.truthRoot = path.join(this.root, '.truth');
    this.runDir = path.join(this.truthRoot, 'runs', this.runId);
    this.stdoutDir = path.join(this.runDir, 'stdout');
    this.stderrDir = path.join(this.runDir, 'stderr');
    this.commandsPath = path.join(this.runDir, 'commands.jsonl');
    this.filesPath = path.join(this.runDir, 'files.jsonl');
    this.hashesPath = path.join(this.runDir, 'hashes.jsonl');
    this.checks = [];
    this.modules = [];
    this.commandIndex = 0;
    this.fileRecords = [];
    this.releaseHashes = new Map();
    this.publicCloneDir = null;
    this.git = {};
  }

  async init() {
    await ensureDir(this.stdoutDir);
    await ensureDir(this.stderrDir);
    await fs.writeFile(this.commandsPath, '', 'utf8');
    await fs.writeFile(this.filesPath, '', 'utf8');
    await fs.writeFile(this.hashesPath, '', 'utf8');
    await writeJson(path.join(this.runDir, 'manifest.json'), {
      schema: 'truth.manifest.v1',
      runId: this.runId,
      project: this.config.project,
      root: this.root,
      releaseDir: this.releaseDir,
      publicRepo: this.config.publicRepo || null,
      startedAt: this.startedAt,
      tool: 'proof-session.mjs'
    });
  }

  addCheck(check) {
    const normalized = {
      id: check.id,
      label: check.label || check.id,
      status: check.status || 'PENDING',
      parent: check.parent ?? null,
      targetAction: check.targetAction ?? null,
      connectedTo: check.connectedTo || {},
      evidence: check.evidence ?? null,
      details: check.details || null,
      moduleId: check.moduleId || check.id
    };
    this.checks.push(normalized);
    this.modules.push({
      moduleId: normalized.moduleId,
      label: normalized.label,
      type: check.type || 'proof_check',
      parent: normalized.parent,
      targetAction: normalized.targetAction,
      connectedTo: normalized.connectedTo,
      status: normalized.status,
      evidence: normalized.evidence,
      details: normalized.details
    });
    return normalized;
  }

  async runCommand(command, opts = {}) {
    const startedAt = nowIso();
    this.commandIndex += 1;
    const id = String(this.commandIndex).padStart(3, '0');
    const cwd = opts.cwd || this.root;
    const commandDisplay = Array.isArray(command) ? command.join(' ') : String(command || '');
    const safeName = `${id}-${opts.name || (Array.isArray(command) ? command[0] : 'command') || 'command'}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const stdoutFile = path.join(this.stdoutDir, `${safeName}.txt`);
    const stderrFile = path.join(this.stderrDir, `${safeName}.txt`);

    const timeoutMs = Number(opts.timeoutMs || this.config.commandTimeoutMs || 120_000);
    const maxOutputBytes = Number(this.config.maxOutputBytes || 2_000_000);

    if (!commandDisplay.trim()) {
      const record = {
        id,
        command: commandDisplay,
        cwd,
        exitCode: null,
        status: 'SKIPPED',
        timedOut: false,
        timeoutMs,
        startedAt,
        finishedAt: nowIso(),
        stdoutFile: relPath(stdoutFile, this.runDir),
        stderrFile: relPath(stderrFile, this.runDir)
      };
      await appendJsonl(this.commandsPath, record);
      return { ...record, stdout: '', stderr: '' };
    }

    const useArray = Array.isArray(command);
    const cmd = useArray ? command[0] : commandDisplay;
    const args = useArray ? command.slice(1) : [];
    const spawnOptions = {
      cwd,
      shell: !useArray,
      env: { ...process.env, ...opts.env },
      windowsHide: true
    };

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode = null;
    let errorMessage = null;
    let timedOut = false;
    let truncatedStdout = false;
    let truncatedStderr = false;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const child = spawn(cmd, args, spawnOptions);
      const timer = setTimeout(() => {
        timedOut = true;
        errorMessage = `Command timed out after ${timeoutMs} ms`;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          if (exitCode === null) {
            try { child.kill('SIGKILL'); } catch {}
          }
        }, 1500).unref?.();
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdoutBytes += Buffer.byteLength(text, 'utf8');
        if (stdoutBytes <= maxOutputBytes) stdout += text;
        else truncatedStdout = true;
      });

      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBytes += Buffer.byteLength(text, 'utf8');
        if (stderrBytes <= maxOutputBytes) stderr += text;
        else truncatedStderr = true;
      });

      child.on('error', (err) => {
        errorMessage = err.message;
        exitCode = -1;
        finish();
      });

      child.on('close', (code) => {
        exitCode = timedOut ? -1 : code;
        finish();
      });
    });

    if (truncatedStdout) stdout += `\n[TRUNCATED: stdout exceeded ${maxOutputBytes} bytes]\n`;
    if (truncatedStderr) stderr += `\n[TRUNCATED: stderr exceeded ${maxOutputBytes} bytes]\n`;
    if (errorMessage) stderr += `\n${errorMessage}\n`;

    await fs.writeFile(stdoutFile, stdout, 'utf8');
    await fs.writeFile(stderrFile, stderr, 'utf8');

    const record = {
      id,
      command: commandDisplay,
      cwd,
      exitCode,
      status: exitCode === 0 ? 'PASS' : 'FAIL',
      timedOut,
      timeoutMs,
      startedAt,
      finishedAt: nowIso(),
      stdoutFile: relPath(stdoutFile, this.runDir),
      stderrFile: relPath(stderrFile, this.runDir)
    };
    await appendJsonl(this.commandsPath, record);
    return { ...record, stdout, stderr };
  }

  async probeGit() {
    const head = await this.runCommand('git rev-parse HEAD', { name: 'git-head' });
    this.git.sourceHead = head.exitCode === 0 ? head.stdout.trim() : null;
    this.addCheck({
      id: 'git_head',
      label: 'Git HEAD readable',
      status: head.exitCode === 0 ? 'PASS' : 'FAIL',
      targetAction: 'read_source_head',
      evidence: { commandId: head.id, stdoutFile: head.stdoutFile, stderrFile: head.stderrFile },
      details: { sourceHead: this.git.sourceHead }
    });

    const branch = await this.runCommand('git branch --show-current', { name: 'git-branch' });
    this.git.branch = branch.exitCode === 0 ? branch.stdout.trim() : null;
    this.addCheck({
      id: 'git_branch',
      label: 'Git branch readable',
      status: branch.exitCode === 0 ? 'PASS' : 'WARN',
      parent: 'git_head',
      targetAction: 'read_branch',
      evidence: { commandId: branch.id, stdoutFile: branch.stdoutFile, stderrFile: branch.stderrFile },
      details: { branch: this.git.branch }
    });

    const status = await this.runCommand(['git', 'status', '--short', '--', '.', ':(exclude).truth'], { name: 'git-status' });
    this.git.statusShort = status.stdout;
    const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0;
    this.addCheck({
      id: 'git_clean',
      label: 'Working tree clean',
      status: dirty ? (this.config.allowDirty ? 'WARN' : 'FAIL') : 'PASS',
      parent: 'git_head',
      targetAction: 'verify_clean_worktree',
      evidence: { commandId: status.id, stdoutFile: status.stdoutFile, stderrFile: status.stderrFile },
      details: { dirty, statusShort: status.stdout.trim() }
    });

    const remoteHead = await this.runCommand('git ls-remote origin HEAD', { name: 'git-remote-head' });
    const remoteLine = remoteHead.stdout.trim().split(/\r?\n/).find(Boolean);
    this.git.remoteHead = remoteHead.exitCode === 0 && remoteLine ? remoteLine.split(/\s+/)[0] : null;
    const remoteMatches = this.git.sourceHead && this.git.remoteHead && this.git.sourceHead === this.git.remoteHead;
    this.addCheck({
      id: 'git_remote_head',
      label: 'Remote HEAD matches local HEAD',
      status: remoteHead.exitCode !== 0 ? 'WARN' : (remoteMatches ? 'PASS' : 'FAIL'),
      parent: 'git_head',
      targetAction: 'verify_remote_head',
      evidence: { commandId: remoteHead.id, stdoutFile: remoteHead.stdoutFile, stderrFile: remoteHead.stderrFile },
      details: { sourceHead: this.git.sourceHead, remoteHead: this.git.remoteHead, remoteMatches }
    });
  }

  async runBuildIfConfigured() {
    if (!this.config.buildCommand) {
      this.addCheck({
        id: 'build_command',
        label: 'Build command configured',
        status: 'WARN',
        targetAction: 'build_public_release',
        evidence: null,
        details: { reason: 'No build command configured. Use --build "npm run build:public-sdk" or .truth/proof.config.json.' }
      });
      return;
    }
    const result = await this.runCommand(this.config.buildCommand, { name: 'build', timeoutMs: this.config.buildTimeoutMs });
    this.addCheck({
      id: 'build_public',
      label: 'Public build completed',
      status: result.exitCode === 0 ? 'PASS' : 'FAIL',
      parent: 'git_clean',
      targetAction: 'build_public_release',
      evidence: { commandId: result.id, stdoutFile: result.stdoutFile, stderrFile: result.stderrFile },
      details: { buildCommand: this.config.buildCommand, exitCode: result.exitCode }
    });
  }

  async walkFiles(rootDir) {
    const files = [];
    async function walk(current) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          await walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    }
    if (await exists(rootDir)) await walk(rootDir);
    return files;
  }

  async inspectReleaseFiles() {
    const releaseExists = await exists(this.releaseDir);
    this.addCheck({
      id: 'release_dir_exists',
      label: 'Release directory exists',
      status: releaseExists ? 'PASS' : 'FAIL',
      parent: this.config.buildCommand ? 'build_public' : 'build_command',
      targetAction: 'open_release_directory',
      evidence: relPath(this.releaseDir, this.root),
      details: { releaseDir: this.releaseDir }
    });
    if (!releaseExists) return [];

    const files = await this.walkFiles(this.releaseDir);
    const tree = files.map((file) => relPath(file, this.releaseDir)).join('\n');
    await fs.writeFile(path.join(this.runDir, 'release-public-tree.txt'), `${tree}\n`, 'utf8');

    this.addCheck({
      id: 'release_files_listed',
      label: 'Release files listed',
      status: files.length ? 'PASS' : 'FAIL',
      parent: 'release_dir_exists',
      targetAction: 'list_release_files',
      evidence: 'release-public-tree.txt',
      details: { fileCount: files.length }
    });

    for (const file of files) {
      const stat = await fs.stat(file);
      const hash = await sha256File(file);
      const ext = path.extname(file).toLowerCase();
      const record = {
        path: relPath(file, this.root),
        releasePath: relPath(file, this.releaseDir),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        sha256: hash,
        extension: ext,
        kind: BINARY_EXTENSIONS.has(ext) ? 'binary' : 'text_or_unknown'
      };
      this.fileRecords.push(record);
      this.releaseHashes.set(record.releasePath, hash);
      await appendJsonl(this.filesPath, record);
      await appendJsonl(this.hashesPath, { path: record.path, sha256: hash });
    }

    this.addCheck({
      id: 'release_files_hashed',
      label: 'Release files opened and hashed',
      status: files.length ? 'PASS' : 'FAIL',
      parent: 'release_files_listed',
      targetAction: 'hash_release_files',
      evidence: ['files.jsonl', 'hashes.jsonl'],
      details: { fileCount: this.fileRecords.length }
    });

    return files;
  }

  async checkReadme() {
    const candidates = ['README.md', 'readme.md', 'README.txt'];
    let readmePath = null;
    for (const name of candidates) {
      const candidate = path.join(this.releaseDir, name);
      if (await exists(candidate)) {
        readmePath = candidate;
        break;
      }
    }

    this.addCheck({
      id: 'readme_exists',
      label: 'Public README exists',
      status: readmePath ? 'PASS' : 'FAIL',
      parent: 'release_files_listed',
      targetAction: 'verify_public_readme',
      evidence: readmePath ? relPath(readmePath, this.root) : null,
      details: { candidates }
    });

    if (!readmePath) return;
    const content = await fs.readFile(readmePath, 'utf8');
    const lower = content.toLowerCase();
    const missing = this.config.requiredReadmeSections.filter((section) => !lower.includes(String(section).toLowerCase()));
    this.addCheck({
      id: 'readme_required_sections',
      label: 'README required sections present',
      status: missing.length ? 'FAIL' : 'PASS',
      parent: 'readme_exists',
      targetAction: 'verify_readme_sections',
      evidence: relPath(readmePath, this.root),
      details: {
        required: this.config.requiredReadmeSections,
        missing
      }
    });
  }

  async scanForbiddenPatterns() {
    const findings = [];
    for (const record of this.fileRecords) {
      const ext = path.extname(record.path).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) continue;
      const fullPath = path.join(this.root, record.path);
      if (record.size > this.config.maxScanBytes) {
        findings.push({ path: record.path, pattern: '<scan skipped>', reason: `file larger than maxScanBytes ${this.config.maxScanBytes}` });
        continue;
      }
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch {
        continue;
      }
      for (const pattern of this.config.forbiddenPatterns) {
        if (!pattern) continue;
        if (content.toLowerCase().includes(String(pattern).toLowerCase())) {
          findings.push({ path: record.path, pattern });
        }
      }
    }
    await writeJson(path.join(this.runDir, 'forbidden-findings.json'), findings);
    const realFindings = findings.filter((f) => f.pattern !== '<scan skipped>');
    this.addCheck({
      id: 'forbidden_pattern_scan',
      label: 'Forbidden/private pattern scan',
      status: realFindings.length ? 'FAIL' : (findings.length ? 'WARN' : 'PASS'),
      parent: 'release_files_hashed',
      targetAction: 'scan_public_boundary',
      evidence: 'forbidden-findings.json',
      details: { findingCount: realFindings.length, skippedCount: findings.length - realFindings.length }
    });
  }

  async verifyPublicClone() {
    if (!this.config.publicRepo) {
      this.addCheck({
        id: 'public_repo_configured',
        label: 'Public repo configured',
        status: 'WARN',
        parent: 'forbidden_pattern_scan',
        targetAction: 'fresh_clone_public_repo',
        evidence: null,
        details: { reason: 'No public repo configured. Use --public-repo <url> or PUBLIC_REPO_URL.' }
      });
      return;
    }

    const tempRoot = path.join(this.runDir, 'tmp');
    await ensureDir(tempRoot);
    this.publicCloneDir = path.join(tempRoot, 'public-clone');
    const clone = await this.runCommand(['git', 'clone', `--depth=${this.config.cloneDepth || 1}`, this.config.publicRepo, this.publicCloneDir], {
      name: 'public-clone',
      cwd: this.root,
      timeoutMs: this.config.cloneTimeoutMs
    });
    this.addCheck({
      id: 'public_repo_fresh_clone',
      label: 'Public repo fresh clone completed',
      status: clone.exitCode === 0 ? 'PASS' : 'FAIL',
      parent: 'forbidden_pattern_scan',
      targetAction: 'fresh_clone_public_repo',
      evidence: { commandId: clone.id, stdoutFile: clone.stdoutFile, stderrFile: clone.stderrFile },
      details: { publicRepo: this.config.publicRepo, cloneDir: relPath(this.publicCloneDir, this.runDir) }
    });
    if (clone.exitCode !== 0) return;

    const publicHead = await this.runCommand('git rev-parse HEAD', { name: 'public-head', cwd: this.publicCloneDir });
    this.git.publicHead = publicHead.exitCode === 0 ? publicHead.stdout.trim() : null;
    this.addCheck({
      id: 'public_repo_head',
      label: 'Public repo HEAD readable',
      status: publicHead.exitCode === 0 ? 'PASS' : 'FAIL',
      parent: 'public_repo_fresh_clone',
      targetAction: 'read_public_head',
      evidence: { commandId: publicHead.id, stdoutFile: publicHead.stdoutFile, stderrFile: publicHead.stderrFile },
      details: { publicHead: this.git.publicHead }
    });

    const cloneFiles = await this.walkFiles(this.publicCloneDir);
    const cloneTree = cloneFiles.map((file) => relPath(file, this.publicCloneDir)).join('\n');
    await fs.writeFile(path.join(this.runDir, 'public-clone-tree.txt'), `${cloneTree}\n`, 'utf8');

    const cloneHashes = new Map();
    for (const file of cloneFiles) {
      const relative = relPath(file, this.publicCloneDir);
      cloneHashes.set(relative, await sha256File(file));
    }

    const missing = [];
    const mismatched = [];
    for (const [relative, hash] of this.releaseHashes) {
      if (!cloneHashes.has(relative)) {
        missing.push(relative);
      } else if (cloneHashes.get(relative) !== hash) {
        mismatched.push(relative);
      }
    }
    const extra = [...cloneHashes.keys()].filter((relative) => !this.releaseHashes.has(relative) && !relative.startsWith('.git/'));
    await writeJson(path.join(this.runDir, 'public-compare.json'), { missing, mismatched, extra });

    this.addCheck({
      id: 'public_repo_matches_release',
      label: 'Public clone matches local release output',
      status: missing.length || mismatched.length || extra.length ? 'FAIL' : 'PASS',
      parent: 'public_repo_head',
      targetAction: 'compare_public_clone',
      evidence: ['public-clone-tree.txt', 'public-compare.json'],
      details: { missingCount: missing.length, mismatchedCount: mismatched.length, extraCount: extra.length }
    });
  }

  async finish() {
    const finishedAt = nowIso();
    const status = computeFinalStatus(this.checks);
    const summary = {
      schema: 'truth.summary.v1',
      project: this.config.project,
      runId: this.runId,
      status,
      sourceHead: this.git.sourceHead || null,
      remoteHead: this.git.remoteHead || null,
      publicHead: this.git.publicHead || null,
      branch: this.git.branch || null,
      repo: this.config.publicRepo || null,
      root: this.root,
      releaseDir: this.releaseDir,
      startedAt: this.startedAt,
      finishedAt,
      checks: this.checks,
      modules: this.modules
    };

    await writeJson(path.join(this.runDir, 'summary.json'), summary);
    await writeJson(path.join(this.truthRoot, 'latest-run.json'), {
      runId: this.runId,
      summary: `.truth/runs/${this.runId}/summary.json`,
      status,
      finishedAt
    });

    const receipt = this.formatReceipt(summary);
    await fs.writeFile(path.join(this.runDir, 'final-receipt.txt'), receipt, 'utf8');

    try {
      const latestDir = path.join(this.truthRoot, 'runs', 'latest');
      if (await exists(latestDir)) await fs.rm(latestDir, { recursive: true, force: true });
      await fs.cp(this.runDir, latestDir, { recursive: true });
    } catch {
      // latest-run.json remains the cross-platform pointer if copying fails.
    }

    return summary;
  }

  formatReceipt(summary) {
    const failChecks = summary.checks.filter((check) => normalizeStatus(check.status) === 'FAIL');
    const warnChecks = summary.checks.filter((check) => normalizeStatus(check.status) === 'WARN');
    const lines = [];
    lines.push(`TRUTH SESSION ${summary.status}`);
    lines.push('');
    lines.push(`Project: ${summary.project}`);
    lines.push(`Run ID: ${summary.runId}`);
    lines.push(`Root: ${summary.root}`);
    lines.push(`Branch: ${summary.branch || 'UNKNOWN'}`);
    lines.push(`Source HEAD: ${summary.sourceHead || 'UNKNOWN'}`);
    lines.push(`Remote HEAD: ${summary.remoteHead || 'UNKNOWN'}`);
    lines.push(`Public HEAD: ${summary.publicHead || 'UNKNOWN'}`);
    lines.push(`Started: ${summary.startedAt}`);
    lines.push(`Finished: ${summary.finishedAt}`);
    lines.push('');
    lines.push(`Checks: ${summary.checks.length}`);
    lines.push(`Failures: ${failChecks.length}`);
    lines.push(`Warnings: ${warnChecks.length}`);
    if (failChecks.length) {
      lines.push('');
      lines.push('FAILED CHECKS:');
      for (const check of failChecks) lines.push(`- ${check.id}: ${check.label}`);
    }
    if (warnChecks.length) {
      lines.push('');
      lines.push('WARNINGS:');
      for (const check of warnChecks) lines.push(`- ${check.id}: ${check.label}`);
    }
    lines.push('');
    lines.push(`Summary: .truth/runs/${summary.runId}/summary.json`);
    lines.push(`Commands: .truth/runs/${summary.runId}/commands.jsonl`);
    lines.push(`Files: .truth/runs/${summary.runId}/files.jsonl`);
    lines.push(`Hashes: .truth/runs/${summary.runId}/hashes.jsonl`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  async run() {
    await this.init();
    await this.probeGit();
    await this.runBuildIfConfigured();
    await this.inspectReleaseFiles();
    await this.checkReadme();
    await this.scanForbiddenPatterns();
    await this.verifyPublicClone();
    return await this.finish();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preliminaryRoot = path.resolve(args.root || process.cwd());
  const configPath = path.join(preliminaryRoot, '.truth', 'proof.config.json');
  const fileConfig = await readJsonIfExists(configPath) || {};
  const config = mergeConfig(fileConfig, args);
  config.root = path.resolve(config.root);
  config.releaseDir = config.releaseDir || 'release-public';
  config.project = config.project || path.basename(config.root);

  const session = new ProofSession(config);
  const summary = await session.run();
  const receiptPath = path.join(session.runDir, 'final-receipt.txt');
  const receipt = await fs.readFile(receiptPath, 'utf8');
  process.stdout.write(receipt);
  process.exitCode = summary.status === 'READY' ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`proof-session failed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});

