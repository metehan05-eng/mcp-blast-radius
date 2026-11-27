# mcp-blast-radius

A **polyglot + TypeScript-deep** Model Context Protocol (MCP) server for **change impact analysis**, **breaking-change detection**, **AST symbol/call-graph tracing**, and **risk/vulnerability scanning** across your codebase.

Built in TypeScript using the official `@modelcontextprotocol/sdk`, `ts-morph` (TypeScript Compiler API), and `web-tree-sitter` (WASM grammars — zero native C++ build required).

---

## Why This Exists

Standard text search (`grep`/`ripgrep`) cannot tell an AI agent:
- Which files and callers will **break** if you rename or change a function, class, or type.
- Which **function** a call site belongs to across Python, Go, Rust, Java, C/C++, or TypeScript.
- Which exported symbols are **dead code** (never imported anywhere).
- Where **security hotspots** (hardcoded secrets, `eval`, SQL interpolation, disabled TLS) live in a multi-language repo.

`mcp-blast-radius` gives Cursor, Claude Desktop, and Antigravity deterministic, AST-backed answers before they edit your code.

---

## Supported Languages

| Layer | Engine | Languages |
| :--- | :--- | :--- |
| **Deep Semantic + Type Graph** | `ts-morph` (TypeScript Compiler API) | TypeScript, TSX, JavaScript, JSX |
| **Polyglot AST + Call Sites** | `web-tree-sitter` (WASM) | Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift, Dart, Scala, JS, TS |
| **Dependency & Risk Scanner** | Cross-language static scanner | All of the above + Shell |

---

## Available MCP Tools

1. **`scan_project_overview`** — Detects all programming languages, extensions, and file counts in a repository.
2. **`analyze_change_impact`** — Computes direct and transitive dependents (blast radius) for a file/symbol, combining polyglot import graphing with deep `ts-morph` reference tracing for TS/JS.
3. **`extract_file_ast_symbols`** — Parses any supported source file with Tree-sitter AST to extract functions, classes/structs/interfaces, imports, and call sites.
4. **`trace_polyglot_symbol_impact`** — Traces definitions and AST-verified call sites (including `callerFunction`) of any symbol across all supported languages in a repo.
5. **`scan_risks_and_vulnerabilities`** — Scans a multi-language codebase for hardcoded secrets, code injection (`eval`/`os.system`), SQL injection patterns, disabled TLS verification, XSS, and `FIXME`/`HACK` markers.
6. **`find_ts_unused_exports`** — Finds exported symbols in TypeScript/JavaScript projects that are never imported by any other file.

---

## Quick Setup (Linux, macOS, Windows)

### 1. Build from source (or install globally)

```bash
npm install
npm run build
```

### 2. Auto-configure Cursor, Claude Desktop & Antigravity

Run the built-in cross-platform setup command:

```bash
node dist/index.js install
```

Or if installed globally (`npm link` / `npm install -g`):

```bash
mcp-blast-radius install
```

This automatically detects your OS (**Linux**, **macOS**, or **Windows**) and registers `blast-radius` in:
- **Cursor**: `~/.cursor/mcp.json`
- **Claude Desktop**:
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json`
- **Antigravity**: `~/.gemini/antigravity/mcp_config.json`

To remove the entry later:

```bash
node dist/index.js uninstall
```

---

## Manual Configuration

If you prefer to configure your MCP client manually, add this to your `mcpServers` JSON:

```json
{
  "mcpServers": {
    "blast-radius": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-blast-radius/dist/index.js"]
    }
  }
}
```

---

## Development & Testing

```bash
npm run build   # Compile TypeScript to dist/
npm test        # Run Vitest suite (TypeScript, Python, Go AST & impact tests)
```

---

## License

MIT
