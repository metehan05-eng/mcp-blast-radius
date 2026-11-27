import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractFileAstSymbols,
  tracePolyglotSymbolImpact,
} from "../src/analyzers/astAnalyzer.js";
import {
  analyzePolyglotBlastRadius,
  getProjectOverview,
  scanProjectRisks,
} from "../src/analyzers/polyglotAnalyzer.js";
import {
  analyzeTsSymbolImpact,
} from "../src/analyzers/tsAnalyzer.js";
import {
  getClientTargets,
  installMcpConfigs,
  uninstallMcpConfigs,
} from "../src/cli/setup.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("mcp-server-code-impact analyzers", () => {
  it("detects TypeScript in project overview", async () => {
    const overview = await getProjectOverview(projectRoot);
    expect(overview.totalFiles).toBeGreaterThanOrEqual(3);
    expect(overview.languages.some((l) => l.language === "TypeScript")).toBe(true);
  });

  it("traces polyglot blast radius for polyglotAnalyzer.ts", async () => {
    const result = await analyzePolyglotBlastRadius(
      projectRoot,
      "src/analyzers/polyglotAnalyzer.ts",
      "getProjectOverview"
    );
    expect(result.directDependents).toContain("src/index.ts");
  });

  it("traces deep TypeScript symbol impact for getProjectOverview", () => {
    const result = analyzeTsSymbolImpact(
      projectRoot,
      "src/analyzers/polyglotAnalyzer.ts",
      "getProjectOverview"
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.impactedFiles).toContain("src/index.ts");
      expect(result.totalReferences).toBeGreaterThanOrEqual(2);
    }
  });

  it("scans project risks without crashing", async () => {
    const risks = await scanProjectRisks(projectRoot);
    expect(risks.scannedFiles).toBeGreaterThanOrEqual(3);
  });

  it("extracts Python and Go symbols via Tree-sitter AST and traces call sites", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-impact-ast-"));
    try {
      const pyFile = path.join(tmpDir, "service.py");
      const goFile = path.join(tmpDir, "main.go");

      await fs.writeFile(
        pyFile,
        `class BillingService:\n    pass\n\ndef calculate_tax(amount):\n    return amount * 0.2\n\ndef checkout():\n    return calculate_tax(100)\n`
      );
      await fs.writeFile(
        goFile,
        `package main\nfunc helper() int { return 1 }\nfunc main() { helper() }\n`
      );

      const pyAst = await extractFileAstSymbols(pyFile);
      expect(pyAst.supported).toBe(true);
      expect(pyAst.language).toBe("Python");
      expect(pyAst.symbols.some((s) => s.name === "calculate_tax" && s.kind === "function")).toBe(true);
      expect(pyAst.symbols.some((s) => s.name === "BillingService" && s.kind === "class_or_type")).toBe(true);
      expect(pyAst.calls.some((c) => c.name === "calculate_tax")).toBe(true);

      const goAst = await extractFileAstSymbols(goFile);
      expect(goAst.supported).toBe(true);
      expect(goAst.language).toBe("Go");
      expect(goAst.symbols.some((s) => s.name === "helper" && s.kind === "function")).toBe(true);

      const impact = await tracePolyglotSymbolImpact(tmpDir, "calculate_tax");
      expect(impact.definitions.length).toBe(1);
      expect(impact.callSites.length).toBe(1);
      expect(impact.callSites[0]?.callerFunction).toBe("checkout");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates cross-platform MCP config paths and safely installs/uninstalls", async () => {
    const linuxTargets = getClientTargets("linux", "/home/alice");
    expect(linuxTargets.find((t) => t.name === "cursor")?.configPath).toBe(
      "/home/alice/.cursor/mcp.json"
    );
    expect(linuxTargets.find((t) => t.name === "claude")?.configPath).toBe(
      "/home/alice/.config/Claude/claude_desktop_config.json"
    );
    expect(linuxTargets.find((t) => t.name === "antigravity")?.configPath).toBe(
      "/home/alice/.gemini/antigravity/mcp_config.json"
    );

    const macTargets = getClientTargets("darwin", "/Users/alice");
    expect(macTargets.find((t) => t.name === "claude")?.configPath).toContain(
      "Library/Application Support/Claude/claude_desktop_config.json"
    );

    const winTargets = getClientTargets("win32", "C:\\Users\\alice", {
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
    });
    expect(winTargets.find((t) => t.name === "claude")?.configPath).toContain(
      "claude_desktop_config.json"
    );

    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-setup-test-"));
    try {
      const targets = getClientTargets("linux", tmpHome);
      const installRes = await installMcpConfigs({
        serverEntryPath: "/tmp/dist/index.js",
        targets,
      });
      expect(installRes.every((r) => r.status === "created")).toBe(true);

      const uninstallRes = await uninstallMcpConfigs({ targets });
      expect(uninstallRes.every((r) => r.status === "removed")).toBe(true);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
