import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function collectIpcCalls(
  filePath: string,
  objectName: "ipcRenderer" | "ipcMain",
  methods: ReadonlySet<string>,
): Set<string> {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const channels = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === objectName
      && methods.has(node.expression.name.text)
    ) {
      const channel = node.arguments[0];
      if (
        channel
        && ts.isPropertyAccessExpression(channel)
        && ts.isIdentifier(channel.expression)
        && channel.expression.text === "IPC"
      ) {
        channels.add(channel.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return channels;
}

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(target);
    return entry.isFile() && target.endsWith(".ts") && !target.endsWith(".test.ts") ? [target] : [];
  });
}

describe("preload to main IPC contract", () => {
  it("registers a main-process handler for every preload invoke/send channel", () => {
    const preloadPath = path.resolve(process.cwd(), "src", "preload", "index.ts");
    const requested = collectIpcCalls(
      preloadPath,
      "ipcRenderer",
      new Set(["invoke", "send"]),
    );
    const registered = new Set<string>();
    for (const filePath of listTypeScriptFiles(path.resolve(process.cwd(), "src", "main"))) {
      for (const channel of collectIpcCalls(filePath, "ipcMain", new Set(["handle", "on"]))) {
        registered.add(channel);
      }
    }

    expect([...requested].filter((channel) => !registered.has(channel)).sort()).toEqual([]);
  });
});
