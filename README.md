# LBE Validator UI

An elegant, secure, and zero-dependency local proof-session viewer and deterministic release verifier for LetterBlack projects.

The **LBE Validator UI** provides a graphical interface and an automated evidence-gathering engine (`proof-session.mjs`) to verify that local codebases are fully prepared, verified, and syntactically clean before deploying or merging to public-facing environments.

---

## 📂 Architecture & Directory Layout

The project is structured to enforce a clean separation of concerns:

```text
LBE_ValidatorUI/
├── config/
│   └── projects.json                  # Registry of target repositories
├── contracts/
│   └── truth.summary.schema.json      # JSON Schema for validation contracts
├── public/                            # Static frontend client files
│   ├── index.html                     # App dashboard layout
│   ├── app.js                         # Vanilla JS client logic (zooming/panning/details)
│   └── style.css                      # Visual theme & responsive style sheet
├── sample-project/                    # Sample workspace with fake proof-runs for demonstration
│   └── .truth/
│       └── ...
├── tools/
│   └── proof-session.mjs              # Local release/audit evidence generator
├── .gitignore                         # Local environment and runtime log exclusions
├── .truth-proof-config.example.json   # Template for project-level proof runs
├── package.json                       # Service metadata and NPM configurations
└── server.mjs                         # Lightweight ES modules HTTP server
```

---

## ⚡ Quick Start

### 1. Launch the Server
Since the backend uses lightweight, native standard libraries, there are no external dependencies to download.

```bash
cd LBE_ValidatorUI
npm start
```

Open your browser and navigate to:
```text
http://localhost:7766
```

### 2. Run Syntax Sanity Checks
Ensure the backend server and the proof-session generator scripts pass syntax validation:
```bash
npm run check
```

---

## 🔌 Connecting Your Projects

### Step 1: Configure Projects Registry
Edit **`config/projects.json`** to define your target codebases. Windows paths can use either forward slashes (`/`) or escaped backslashes (`\\`).

```json
{
  "projects": [
    {
      "id": "gpt-sync",
      "name": "GPT Sync",
      "root": "../../..",
      "truth": "../../../.truth/runs/latest/summary.json"
    }
  ]
}
```

### Step 2: Establish the Proof-Session Creator
To generate validation proof, copy **`tools/proof-session.mjs`** and **`.truth-proof-config.example.json`** into your project repository.

Rename the config file to:
```text
<project-root>/.truth/proof.config.json
```

Modify the config file according to your project settings (e.g., target build commands, public repo clone URLs, and release-public directory paths).

### Step 3: Run Validation and Generate Evidence
Run the proof engine from your project repository root:
```bash
node tools/proof-session.mjs
```

Or run with explicit overrides:
```bash
node tools/proof-session.mjs \
  --project "LBE Sentinel" \
  --release-dir release-public \
  --build "npm run build" \
  --public-repo "https://github.com/Letterblack0306/LetterBlack-Sentinel.git"
```

The script will:
1. Probe git heads, branches, and worktree clean status.
2. Build the production release directory.
3. SHA-256 hash all output assets.
4. Scan all release assets for private keys, secret tokens, or local environment trails.
5. Clone and verify that the public branch matches local release assets exactly.
6. Write a standardized receipt and JSON summary to `.truth/runs/<run-id>/summary.json`.

---

## 📊 Status Matrix

| Status | Code | Description | Visual Color |
| :--- | :---: | :--- | :---: |
| **`READY`** | `0` | All deterministic release proof and checks passed. Code is safe. | 🟢 Green |
| **`BLOCKED`** | `1` | An absolute deterministic failure (e.g. key leaks or build error) was detected. | 🔴 Red |
| **`UNKNOWN`** | `1` | Warnings were raised, or remote public matching couldn't be computed. | 🟡 Yellow |

---

## 🛡️ Core Directives & Safety
- **Work on `main` only:** Never create temporary branch layers.
- **No Manual PASS:** Agents cannot manually mark runs as `PASS`. They must run `proof-session.mjs` to establish empirical, unforgeable evidence.
- **Strict Git Hygiene:** Only stage specific modified files. Never use destructive staging commands.
