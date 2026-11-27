#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  extractFileAstSymbols,
  tracePolyglotSymbolImpact,
} from "./analyzers/astAnalyzer.js";
import {
  analyzePolyglotBlastRadius,
  detectLanguage,
  getProjectOverview,
  scanProjectRisks,
} from "./analyzers/polyglotAnalyzer.js";
import {
  analyzeTsSymbolImpact,
  findTsUnusedExports,
} from "./analyzers/tsAnalyzer.js";
import { installMcpConfigs, uninstallMcpConfigs } from "./cli/setup.js";

const server = new McpServer({
  name: "mcp-blast-radius",
  version: "0.1.0",
});

server.tool(
  "scan_project_overview",
  "Scan a repository to detect all programming languages, file counts, and overall codebase composition.",
  {
    projectDir: z
      .string()
      .describe("Absolute or relative path to the project root directory."),
  },
  async ({ projectDir }) => {
    const overview = await getProjectOverview(projectDir);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(overview, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "analyze_change_impact",
  "Analyze the blast radius and breaking-change impact of modifying a file or symbol. Uses deep TypeScript Compiler AST analysis for TS/JS and polyglot import/reference graphing for Python, Go, Rust, Java, C/C++, C#, PHP, Ruby, etc.",
  {
    projectDir: z.string().describe("Path to the project root directory."),
    targetFile: z
      .string()
      .describe("Path to the file being modified (relative to projectDir or absolute)."),
    symbolName: z
      .string()
      .optional()
      .describe("Optional function, class, type, or variable name being changed."),
  },
  async ({ projectDir, targetFile, symbolName }) => {
    const lang = detectLanguage(targetFile);
    const polyglotResult = await analyzePolyglotBlastRadius(
      projectDir,
      targetFile,
      symbolName
    );

    let tsDeepResult: unknown = undefined;
    if (
      symbolName &&
      (lang === "TypeScript" || lang === "JavaScript")
    ) {
      tsDeepResult = analyzeTsSymbolImpact(projectDir, targetFile, symbolName);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              polyglotBlastRadius: polyglotResult,
              typeScriptDeepAnalysis: tsDeepResult,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "scan_risks_and_vulnerabilities",
  "Scan a multi-language codebase for potential security vulnerabilities, unsafe patterns, hardcoded secrets, and fragility markers.",
  {
    projectDir: z.string().describe("Path to the project root directory."),
    maxFindings: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of findings to return."),
  },
  async ({ projectDir, maxFindings }) => {
    const result = await scanProjectRisks(projectDir, maxFindings);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "find_ts_unused_exports",
  "Find exported symbols in a TypeScript/JavaScript project that are never imported by any other file.",
  {
    projectDir: z.string().describe("Path to the TypeScript project root directory."),
  },
  async ({ projectDir }) => {
    const result = findTsUnusedExports(projectDir);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "extract_file_ast_symbols",
  "Parse any supported source file (Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift, Dart, Scala, JS, TS) using Tree-sitter AST to extract functions, classes/structs, imports, and function calls.",
  {
    filePath: z.string().describe("Path to the source file to parse."),
  },
  async ({ filePath }) => {
    const result = await extractFileAstSymbols(filePath);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "trace_polyglot_symbol_impact",
  "Trace definitions and AST-verified call sites of a function or type across all supported programming languages in a project.",
  {
    projectDir: z.string().describe("Path to the project root directory."),
    symbolName: z.string().describe("Name of the function, class, struct, or method to trace."),
  },
  async ({ projectDir, symbolName }) => {
    const result = await tracePolyglotSymbolImpact(projectDir, symbolName);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const entryPath = fileURLToPath(import.meta.url);

  if (cmd === "install" || cmd === "setup") {
    const results = await installMcpConfigs({ serverEntryPath: entryPath });
    console.log("mcp-blast-radius setup results:");
    for (const r of results) {
      console.log(`- [${r.status.toUpperCase()}] ${r.label}: ${r.configPath}${r.reason ? ` (${r.reason})` : ""}`);
    }
    return;
  }

  if (cmd === "uninstall") {
    const results = await uninstallMcpConfigs();
    console.log("mcp-blast-radius uninstall results:");
    for (const r of results) {
      console.log(`- [${r.status.toUpperCase()}] ${r.label}: ${r.configPath}${r.reason ? ` (${r.reason})` : ""}`);
    }
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in mcp-blast-radius:", err);
  process.exit(1);
});
