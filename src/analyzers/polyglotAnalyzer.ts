import fs from "node:fs/promises";
import path from "node:path";

export interface LanguageStats {
  language: string;
  fileCount: number;
  extensions: string[];
}

export interface RiskFinding {
  file: string;
  line: number;
  severity: "high" | "medium" | "low";
  category: string;
  message: string;
  snippet: string;
}

export interface BlastRadiusResult {
  targetFile: string;
  language: string;
  directDependents: string[];
  transitiveDependents: string[];
  symbolMentions: Array<{ file: string; line: number; snippet: string }>;
  riskLevel: "low" | "medium" | "high";
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  ".idea",
  ".vscode",
  "coverage",
]);

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".c": "C",
  ".h": "C/C++ Header",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".php": "PHP",
  ".rb": "Ruby",
  ".swift": "Swift",
  ".dart": "Dart",
  ".scala": "Scala",
  ".sh": "Shell",
};

const MAX_FILE_BYTES = 512 * 1024; // 512 KB per file for fast static scanning

export async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXT_TO_LANG[ext]) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(path.resolve(rootDir));
  return files;
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? "Unknown";
}

export async function getProjectOverview(rootDir: string): Promise<{
  rootDir: string;
  totalFiles: number;
  languages: LanguageStats[];
}> {
  const resolved = path.resolve(rootDir);
  const files = await collectSourceFiles(resolved);
  const map = new Map<string, { count: number; exts: Set<string> }>();

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const lang = detectLanguage(file);
    const current = map.get(lang) ?? { count: 0, exts: new Set<string>() };
    current.count += 1;
    current.exts.add(ext);
    map.set(lang, current);
  }

  const languages: LanguageStats[] = Array.from(map.entries())
    .map(([language, info]) => ({
      language,
      fileCount: info.count,
      extensions: Array.from(info.exts).sort(),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  return {
    rootDir: resolved,
    totalFiles: files.length,
    languages,
  };
}

function extractImportSpecifiers(content: string, lang: string): string[] {
  const specs: string[] = [];
  const patterns: RegExp[] = [];

  if (lang === "TypeScript" || lang === "JavaScript") {
    patterns.push(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
      /require\s*\(\s*["']([^"']+)["']\s*\)/g,
      /import\s*\(\s*["']([^"']+)["']\s*\)/g
    );
  } else if (lang === "Python") {
    patterns.push(
      /^\s*from\s+([.\w]+)\s+import\s+/gm,
      /^\s*import\s+([\w.,\s]+)/gm
    );
  } else if (lang === "Go") {
    patterns.push(/import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g);
  } else if (lang === "Rust") {
    patterns.push(/^\s*(?:use|mod)\s+([\w:]+)/gm);
  } else if (lang === "Java" || lang === "Kotlin" || lang === "C#") {
    patterns.push(/^\s*(?:import|using)\s+([\w.]+)/gm);
  } else if (lang === "C" || lang === "C++" || lang === "C/C++ Header") {
    patterns.push(/^\s*#include\s+["<]([^">]+)[">]/gm);
  } else if (lang === "PHP") {
    patterns.push(
      /^\s*use\s+([\w\\]+)/gm,
      /(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g
    );
  } else if (lang === "Ruby") {
    patterns.push(/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm);
  }

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const raw = (match[1] || match[2] || "").trim();
      if (!raw) continue;
      if (lang === "Go" && raw.includes("\n")) {
        for (const line of raw.split("\n")) {
          const m = line.match(/"([^"]+)"/);
          if (m?.[1]) specs.push(m[1]);
        }
      } else {
        specs.push(raw);
      }
    }
  }

  return specs;
}

function doesImportReferenceTarget(
  importerFile: string,
  specifier: string,
  targetFile: string,
  rootDir: string
): boolean {
  const targetBaseNoExt = path.basename(targetFile, path.extname(targetFile));
  const targetRelNoExt = path
    .relative(rootDir, targetFile)
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "");

  if (specifier.startsWith(".")) {
    const resolved = path
      .resolve(path.dirname(importerFile), specifier)
      .replace(/\\/g, "/");
    const targetNoExt = targetFile.replace(/\\/g, "/").replace(/\.[^.]+$/, "");
    if (
      resolved === targetNoExt ||
      resolved + "/index" === targetNoExt
    ) {
      return true;
    }
  }

  const normalizedSpec = specifier.replace(/\\/g, "/").replace(/\.[^.]+$/, "");
  if (
    normalizedSpec === targetRelNoExt ||
    normalizedSpec.endsWith("/" + targetBaseNoExt) ||
    normalizedSpec.endsWith("." + targetBaseNoExt) ||
    normalizedSpec.endsWith("::" + targetBaseNoExt) ||
    normalizedSpec === targetBaseNoExt
  ) {
    return true;
  }

  return false;
}

export async function analyzePolyglotBlastRadius(
  rootDir: string,
  targetFile: string,
  symbolName?: string
): Promise<BlastRadiusResult> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, targetFile);
  const allFiles = await collectSourceFiles(resolvedRoot);
  const targetLang = detectLanguage(resolvedTarget);

  const reverseGraph = new Map<string, Set<string>>();
  const symbolMentions: Array<{ file: string; line: number; snippet: string }> = [];
  const symbolRegex = symbolName
    ? new RegExp(`\\b${escapeRegExp(symbolName)}\\b`)
    : null;

  for (const file of allFiles) {
    let stat;
    try {
      stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const lang = detectLanguage(file);
    const imports = extractImportSpecifiers(content, lang);

    for (const candidateTarget of allFiles) {
      if (candidateTarget === file) continue;
      if (imports.some((spec) => doesImportReferenceTarget(file, spec, candidateTarget, resolvedRoot))) {
        const set = reverseGraph.get(candidateTarget) ?? new Set<string>();
        set.add(file);
        reverseGraph.set(candidateTarget, set);
      }
    }

    if (symbolRegex && file !== resolvedTarget) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (symbolRegex.test(lines[i])) {
          symbolMentions.push({
            file: path.relative(resolvedRoot, file),
            line: i + 1,
            snippet: lines[i].trim().slice(0, 140),
          });
        }
      }
    }
  }

  const directSet = reverseGraph.get(resolvedTarget) ?? new Set<string>();
  const directDependents = Array.from(directSet).map((f) =>
    path.relative(resolvedRoot, f)
  );

  // BFS for transitive dependents
  const visited = new Set<string>([resolvedTarget, ...directSet]);
  const queue = Array.from(directSet);
  const transitive: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const parents = reverseGraph.get(current);
    if (!parents) continue;
    for (const p of parents) {
      if (!visited.has(p)) {
        visited.add(p);
        queue.push(p);
        transitive.push(path.relative(resolvedRoot, p));
      }
    }
  }

  const totalImpacted = directDependents.length + transitive.length;
  const riskLevel: "low" | "medium" | "high" =
    totalImpacted >= 8 ? "high" : totalImpacted >= 3 ? "medium" : "low";

  return {
    targetFile: path.relative(resolvedRoot, resolvedTarget),
    language: targetLang,
    directDependents: directDependents.sort(),
    transitiveDependents: transitive.sort(),
    symbolMentions: symbolMentions.slice(0, 100),
    riskLevel,
  };
}

interface RiskRule {
  severity: "high" | "medium" | "low";
  category: string;
  message: string;
  pattern: RegExp;
}

const RISK_RULES: RiskRule[] = [
  {
    severity: "high",
    category: "Hardcoded Secret",
    message: "Potential hardcoded API key, token, or password detected.",
    pattern: /(?:api_?key|secret_?key|access_?token|password|private_?key)\s*[:=]\s*["'][A-Za-z0-9_\-\/+]{12,}["']/i,
  },
  {
    severity: "high",
    category: "Code Injection",
    message: "Dynamic code execution (eval / exec / Function) can lead to injection vulnerabilities.",
    pattern: /\b(?:eval|execSync|os\.system|subprocess\.call)\s*\(/,
  },
  {
    severity: "high",
    category: "SQL Injection Risk",
    message: "String interpolation or concatenation inside SQL query detected.",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+[\s\S]{0,60}(?:\$\{|\+\s*\w+|%\s*\()/i,
  },
  {
    severity: "medium",
    category: "Insecure TLS",
    message: "TLS/SSL certificate verification appears disabled.",
    pattern: /(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true)/,
  },
  {
    severity: "medium",
    category: "Unsafe HTML / XSS",
    message: "Direct DOM/HTML injection pattern detected.",
    pattern: /(?:dangerouslySetInnerHTML|\.innerHTML\s*=)/,
  },
  {
    severity: "low",
    category: "Technical Debt / Risk Marker",
    message: "FIXME or HACK marker indicating known fragility.",
    pattern: /\b(?:FIXME|HACK|XXX)\b/,
  },
];

export async function scanProjectRisks(
  rootDir: string,
  maxFindings = 100
): Promise<{
  rootDir: string;
  scannedFiles: number;
  totalFindings: number;
  findings: RiskFinding[];
}> {
  const resolvedRoot = path.resolve(rootDir);
  const files = await collectSourceFiles(resolvedRoot);
  const findings: RiskFinding[] = [];
  let scannedFiles = 0;

  for (const file of files) {
    if (findings.length >= maxFindings) break;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(file, "utf8");
      scannedFiles += 1;
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const rule of RISK_RULES) {
          if (rule.pattern.test(line)) {
            findings.push({
              file: path.relative(resolvedRoot, file),
              line: i + 1,
              severity: rule.severity,
              category: rule.category,
              message: rule.message,
              snippet: line.trim().slice(0, 140),
            });
            if (findings.length >= maxFindings) break;
          }
        }
        if (findings.length >= maxFindings) break;
      }
    } catch {
      continue;
    }
  }

  return {
    rootDir: resolvedRoot,
    scannedFiles,
    totalFindings: findings.length,
    findings,
  };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
