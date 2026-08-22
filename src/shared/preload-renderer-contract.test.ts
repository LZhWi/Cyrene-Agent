import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PRELOAD_API_NAMES,
  shouldExposePreloadApi,
  type PreloadWindowRole,
} from "./preload-access";

const ROOT = path.resolve(process.cwd(), "src", "renderer");
const ENTRIES: Record<PreloadWindowRole, string> = {
  main: path.join(ROOT, "main.ts"),
  chat: path.join(ROOT, "chat", "main.ts"),
  sidebar: path.join(ROOT, "sidebar", "sidebar.ts"),
  tasks: path.join(ROOT, "tasks", "tasks.ts"),
  settings: path.join(ROOT, "settings", "settings.ts"),
  "sticker-manager": path.join(ROOT, "sticker-manager", "main.ts"),
  call: path.join(ROOT, "call", "main.ts"),
};

const knownApis = new Set<string>(PRELOAD_API_NAMES);

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isWindowExpression(expression: ts.Expression): boolean {
  const current = unwrap(expression);
  return ts.isIdentifier(current) && current.text === "window";
}

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectRendererApis(entry: string): Set<string> {
  const visited = new Set<string>();
  const found = new Set<string>();
  const visitFile = (filePath: string): void => {
    const normalized = path.normalize(filePath);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    const sourceText = fs.readFileSync(normalized, "utf8");
    const source = ts.createSourceFile(normalized, sourceText, ts.ScriptTarget.Latest, true);
    const visitNode = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isWindowExpression(node.expression)) {
        if (knownApis.has(node.name.text)) found.add(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && isWindowExpression(node.expression)) {
        const argument = node.argumentExpression;
        if (argument && ts.isStringLiteral(argument) && knownApis.has(argument.text)) found.add(argument.text);
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const dependency = resolveRelativeImport(normalized, node.moduleSpecifier.text);
        if (dependency) visitFile(dependency);
      }
      ts.forEachChild(node, visitNode);
    };
    visitNode(source);
  };
  visitFile(entry);
  return found;
}

describe("renderer to preload access contract", () => {
  for (const [role, entry] of Object.entries(ENTRIES) as Array<[PreloadWindowRole, string]>) {
    it(`${role} exposes every preload API used by its renderer import graph`, () => {
      const missing = [...collectRendererApis(entry)]
        .filter((api) => !shouldExposePreloadApi(role, api))
        .sort();
      expect(missing).toEqual([]);
    });
  }
});
