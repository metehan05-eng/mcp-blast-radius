import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import Parser from "web-tree-sitter";
import { collectSourceFiles, detectLanguage } from "./polyglotAnalyzer.js";

const require = createRequire(import.meta.url);

export interface AstSymbol {
  name: string;
  kind: "function" | "class_or_type" | "import";
  line: number;
  endLine: number;
}

export interface AstCallSite {
  file: string;
  language: string;
  line: number;
  callerFunction?: string;
  snippet: string;
}

export interface FileAstResult {
  file: string;
  language: string;
  supported: boolean;
  symbols: AstSymbol[];
  calls: Array<{ name: string; line: number }>;
}

export interface PolyglotSymbolImpact {
  symbolName: string;
  scannedFiles: number;
  definitions: Array<{ file: string; language: string; kind: string; line: number }>;
  callSites: AstCallSite[];
  impactedFiles: string[];
  riskLevel: "low" | "medium" | "high";
}

const EXT_TO_WASM: Record<string, string> = {
  ".py": "tree-sitter-python.wasm",
  ".go": "tree-sitter-go.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".java": "tree-sitter-java.wasm",
  ".kt": "tree-sitter-kotlin.wasm",
  ".kts": "tree-sitter-kotlin.wasm",
  ".c": "tree-sitter-c.wasm",
  ".h": "tree-sitter-c.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".cs": "tree-sitter-c_sharp.wasm",
  ".php": "tree-sitter-php.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".swift": "tree-sitter-swift.wasm",
  ".dart": "tree-sitter-dart.wasm",
  ".scala": "tree-sitter-scala.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
};

const FUNCTION_NODE_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "method_definition",
  "method_declaration",
  "function_item",
  "arrow_function",
  "func_literal",
]);

const TYPE_NODE_TYPES = new Set([
  "class_definition",
  "class_declaration",
  "struct_item",
  "struct_specifier",
  "type_declaration",
  "interface_declaration",
  "enum_declaration",
  "enum_item",
  "trait_item",
]);

const IMPORT_NODE_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "use_declaration",
  "preproc_include",
  "using_directive",
  "namespace_use_declaration",
]);

const CALL_NODE_TYPES = new Set([
  "call",
  "call_expression",
  "method_invocation",
  "invocation_expression",
  "function_call_expression",
]);

let parserInitialized = false;
const languageCache = new Map<string, Parser.Language>();
let wasmDir: string | null = null;

function getWasmDir(): string {
  if (wasmDir) return wasmDir;
  const pkgPath = require.resolve("tree-sitter-wasms/package.json");
  wasmDir = path.join(path.dirname(pkgPath), "out");
  return wasmDir;
}

async function ensureInit(): Promise<void> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
}

async function getLanguageForFile(filePath: string): Promise<Parser.Language | null> {
  const ext = path.extname(filePath).toLowerCase();
  const wasmFile = EXT_TO_WASM[ext];
  if (!wasmFile) return null;

  const cached = languageCache.get(wasmFile);
  if (cached) return cached;

  await ensureInit();
  const fullWasmPath = path.join(getWasmDir(), wasmFile);
  try {
    await fs.access(fullWasmPath);
  } catch {
    return null;
  }

  const lang = await Parser.Language.load(fullWasmPath);
  languageCache.set(wasmFile, lang);
  return lang;
}

function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameField = node.childForFieldName("name");
  if (nameField) return nameField.text;

  const declField = node.childForFieldName("declarator");
  if (declField) {
    const inner = declField.childForFieldName("declarator") ?? declField;
    return inner.text.split("(")[0].trim() || null;
  }

  for (const child of node.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier"
    ) {
      return child.text;
    }
  }
  return null;
}

function getCallName(node: Parser.SyntaxNode): string | null {
  const fnNode =
    node.childForFieldName("function") ??
    node.childForFieldName("name") ??
    node.namedChildren[0];
  if (!fnNode) return null;
  const text = fnNode.text;
  const parts = text.split(/[.:->]+/);
  return parts[parts.length - 1]?.trim() || null;
}

export async function extractFileAstSymbols(
  filePath: string
): Promise<FileAstResult> {
  const resolved = path.resolve(filePath);
  const language = detectLanguage(resolved);
  const tsLang = await getLanguageForFile(resolved);

  if (!tsLang) {
    return {
      file: resolved,
      language,
      supported: false,
      symbols: [],
      calls: [],
    };
  }

  const content = await fs.readFile(resolved, "utf8");
  const parser = new Parser();
  parser.setLanguage(tsLang);
  const tree = parser.parse(content);

  const symbols: AstSymbol[] = [];
  const calls: Array<{ name: string; line: number }> = [];

  function walk(node: Parser.SyntaxNode): void {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const name = getNodeName(node);
      if (name) {
        symbols.push({
          name,
          kind: "function",
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
    } else if (TYPE_NODE_TYPES.has(node.type)) {
      const name = getNodeName(node);
      if (name) {
        symbols.push({
          name,
          kind: "class_or_type",
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
    } else if (IMPORT_NODE_TYPES.has(node.type)) {
      symbols.push({
        name: node.text.trim().slice(0, 120),
        kind: "import",
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    } else if (CALL_NODE_TYPES.has(node.type)) {
      const callName = getCallName(node);
      if (callName) {
        calls.push({
          name: callName,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  return {
    file: resolved,
    language,
    supported: true,
    symbols,
    calls: calls.slice(0, 200),
  };
}

export async function tracePolyglotSymbolImpact(
  projectDir: string,
  symbolName: string
): Promise<PolyglotSymbolImpact> {
  const resolvedRoot = path.resolve(projectDir);
  const files = await collectSourceFiles(resolvedRoot);

  const definitions: Array<{
    file: string;
    language: string;
    kind: string;
    line: number;
  }> = [];
  const callSites: AstCallSite[] = [];
  const impactedSet = new Set<string>();
  let scannedFiles = 0;

  for (const file of files) {
    const tsLang = await getLanguageForFile(file);
    if (!tsLang) continue;

    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 512 * 1024) continue;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    scannedFiles += 1;
    const relFile = path.relative(resolvedRoot, file);
    const language = detectLanguage(file);
    const lines = content.split("\n");

    const parser = new Parser();
    parser.setLanguage(tsLang);
    const tree = parser.parse(content);

    function walk(node: Parser.SyntaxNode, currentFn?: string): void {
      let nextFn = currentFn;

      if (FUNCTION_NODE_TYPES.has(node.type)) {
        const name = getNodeName(node);
        if (name) {
          nextFn = name;
          if (name === symbolName) {
            definitions.push({
              file: relFile,
              language,
              kind: "function",
              line: node.startPosition.row + 1,
            });
          }
        }
      } else if (TYPE_NODE_TYPES.has(node.type)) {
        const name = getNodeName(node);
        if (name === symbolName) {
          definitions.push({
            file: relFile,
            language,
            kind: "class_or_type",
            line: node.startPosition.row + 1,
          });
        }
      } else if (CALL_NODE_TYPES.has(node.type)) {
        const callName = getCallName(node);
        if (callName === symbolName) {
          const lineNum = node.startPosition.row + 1;
          impactedSet.add(relFile);
          callSites.push({
            file: relFile,
            language,
            line: lineNum,
            callerFunction: currentFn,
            snippet: (lines[lineNum - 1] ?? "").trim().slice(0, 140),
          });
        }
      }

      for (const child of node.namedChildren) {
        walk(child, nextFn);
      }
    }

    walk(tree.rootNode);
  }

  const impactedFiles = Array.from(impactedSet).sort();
  const riskLevel: "low" | "medium" | "high" =
    impactedFiles.length >= 6 ? "high" : impactedFiles.length >= 2 ? "medium" : "low";

  return {
    symbolName,
    scannedFiles,
    definitions,
    callSites: callSites.slice(0, 150),
    impactedFiles,
    riskLevel,
  };
}
