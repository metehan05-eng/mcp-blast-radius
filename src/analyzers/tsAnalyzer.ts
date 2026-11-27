import fs from "node:fs";
import path from "node:path";
import { Node, Project } from "ts-morph";

export interface TsSymbolReference {
  file: string;
  line: number;
  column: number;
  isDefinition: boolean;
  snippet: string;
}

export interface TsSymbolImpactResult {
  symbolName: string;
  file: string;
  kind: string;
  totalReferences: number;
  impactedFiles: string[];
  references: TsSymbolReference[];
}

export interface UnusedExport {
  file: string;
  name: string;
  kind: string;
  line: number;
}

function createTsProject(projectDir: string): Project {
  const resolved = path.resolve(projectDir);
  const tsConfigPath = path.join(resolved, "tsconfig.json");

  if (fs.existsSync(tsConfigPath)) {
    return new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: false,
    });
  }

  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
    },
  });
  project.addSourceFilesAtPaths([
    path.join(resolved, "**/*.{ts,tsx,js,jsx}"),
    `!${path.join(resolved, "**/node_modules/**")}`,
    `!${path.join(resolved, "**/dist/**")}`,
  ]);
  return project;
}

export function analyzeTsSymbolImpact(
  projectDir: string,
  targetFile: string,
  symbolName: string
): TsSymbolImpactResult | { error: string } {
  const resolvedDir = path.resolve(projectDir);
  const resolvedFile = path.resolve(resolvedDir, targetFile);
  const project = createTsProject(resolvedDir);
  const sourceFile = project.getSourceFile(resolvedFile);

  if (!sourceFile) {
    return {
      error: `Source file not found in TypeScript project: ${resolvedFile}`,
    };
  }

  const candidates: Node[] = [
    ...sourceFile.getFunctions().filter((n) => n.getName() === symbolName),
    ...sourceFile.getClasses().filter((n) => n.getName() === symbolName),
    ...sourceFile.getInterfaces().filter((n) => n.getName() === symbolName),
    ...sourceFile.getTypeAliases().filter((n) => n.getName() === symbolName),
    ...sourceFile.getEnums().filter((n) => n.getName() === symbolName),
    ...sourceFile
      .getVariableDeclarations()
      .filter((n) => n.getName() === symbolName),
  ];

  if (candidates.length === 0) {
    return {
      error: `Symbol "${symbolName}" not found in ${path.relative(resolvedDir, resolvedFile)}`,
    };
  }

  const targetNode = candidates[0];
  if (!Node.isReferenceFindable(targetNode)) {
    return {
      error: `Symbol "${symbolName}" is not reference-findable.`,
    };
  }

  const references: TsSymbolReference[] = [];
  const impactedFileSet = new Set<string>();

  for (const refSymbol of targetNode.findReferences()) {
    for (const ref of refSymbol.getReferences()) {
      const refFile = ref.getSourceFile().getFilePath();
      const relFile = path.relative(resolvedDir, refFile);
      const node = ref.getNode();
      const startLine = node.getStartLineNumber();
      const lineText = ref
        .getSourceFile()
        .getFullText()
        .split("\n")[startLine - 1] ?? "";

      if (!ref.isDefinition()) {
        impactedFileSet.add(relFile);
      }

      references.push({
        file: relFile,
        line: startLine,
        column: node.getStart() - node.getStartLinePos() + 1,
        isDefinition: Boolean(ref.isDefinition()),
        snippet: lineText.trim().slice(0, 140),
      });
    }
  }

  return {
    symbolName,
    file: path.relative(resolvedDir, resolvedFile),
    kind: targetNode.getKindName(),
    totalReferences: references.length,
    impactedFiles: Array.from(impactedFileSet).sort(),
    references: references.slice(0, 150),
  };
}

export function findTsUnusedExports(projectDir: string): {
  totalChecked: number;
  unusedExports: UnusedExport[];
} {
  const resolvedDir = path.resolve(projectDir);
  const project = createTsProject(resolvedDir);
  const unusedExports: UnusedExport[] = [];
  let totalChecked = 0;

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (filePath.includes("node_modules") || sourceFile.isDeclarationFile()) {
      continue;
    }

    for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
      if (name === "default") continue;
      for (const decl of declarations) {
        if (!Node.isReferenceFindable(decl)) continue;
        totalChecked += 1;

        let externalRefs = 0;
        for (const refSymbol of decl.findReferences()) {
          for (const ref of refSymbol.getReferences()) {
            if (
              !ref.isDefinition() &&
              ref.getSourceFile().getFilePath() !== filePath
            ) {
              externalRefs += 1;
            }
          }
        }

        if (externalRefs === 0) {
          unusedExports.push({
            file: path.relative(resolvedDir, filePath),
            name,
            kind: decl.getKindName(),
            line: decl.getStartLineNumber(),
          });
        }
      }
    }
  }

  return {
    totalChecked,
    unusedExports: unusedExports.slice(0, 200),
  };
}
