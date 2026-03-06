import Parser from "web-tree-sitter";
import {
  type ChangedFile,
  ChangeType,
  type CodeElement,
  ElementKind,
} from "./models.ts";

// Embedded WASM assets — baked into the binary at compile time
// @ts-ignore: Bun-specific import attribute
import treeSitterRuntimeWasm from "../node_modules/web-tree-sitter/tree-sitter.wasm" with { type: "file" };
// @ts-ignore: Bun-specific import attribute
import pythonWasm from "../node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
// @ts-ignore: Bun-specific import attribute
import typescriptWasm from "../node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
// @ts-ignore: Bun-specific import attribute
import tsxWasm from "../node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };

let initialized = false;
const parsers: Map<string, Parser> = new Map();
const languages: Map<string, Parser.Language> = new Map();

const EXT_TO_WASM: Record<string, string> = {
  ".py": pythonWasm,
  ".ts": typescriptWasm,
  ".tsx": tsxWasm,
};

async function ensureInit() {
  if (!initialized) {
    await Parser.init({ locateFile: () => treeSitterRuntimeWasm });
    initialized = true;
  }
}

async function getParser(path: string): Promise<Parser | null> {
  const ext = Object.keys(EXT_TO_WASM).find((e) => path.endsWith(e));
  if (!ext) return null;

  if (parsers.has(ext)) return parsers.get(ext)!;

  await ensureInit();

  if (!languages.has(ext)) {
    const lang = await Parser.Language.load(EXT_TO_WASM[ext]!);
    languages.set(ext, lang);
  }

  const parser = new Parser();
  parser.setLanguage(languages.get(ext)!);
  parsers.set(ext, parser);
  return parser;
}

type TSNode = Parser.SyntaxNode;

function nodeLineRange(node: TSNode): [number, number] {
  return [node.startPosition.row + 1, node.endPosition.row + 1];
}

function overlaps(node: TSNode, changedLines: Set<number>): boolean {
  const [start, end] = nodeLineRange(node);
  for (let line = start; line <= end; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

function extractName(node: TSNode): string | null {
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "type_identifier") {
      return child.text;
    }
  }
  return null;
}

function extractAssignmentName(node: TSNode): string | null {
  if (node.children.length > 0) {
    const target = node.children[0]!;
    if (target.type === "identifier") return target.text;
  }
  return null;
}

function extractDeclaratorName(node: TSNode): string | null {
  for (const child of node.children) {
    if (child.type === "variable_declarator") {
      for (const grandchild of child.children) {
        if (grandchild.type === "identifier") return grandchild.text;
      }
    }
  }
  return null;
}

// Python definition node types
const PY_DEF_TYPES = new Set(["function_definition", "class_definition"]);

// TypeScript definition node types
const TS_DEF_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "method_definition",
  "interface_declaration",
  "enum_declaration",
]);

// TypeScript variable declaration types
const TS_VAR_TYPES = new Set(["lexical_declaration", "variable_declaration"]);

// Node types that introduce a class body scope
const CLASS_BODY_TYPES = new Set(["class_body"]);

// Node types that propagate parent_is_class
const BLOCK_TYPES = new Set(["block", "statement_block"]);

function walkTree(
  node: TSNode,
  changedLines: Set<number>,
  filePath: string,
): CodeElement[] {
  const elements: CodeElement[] = [];
  walkNode(node, changedLines, filePath, elements, false);
  return elements;
}

function walkNode(
  node: TSNode,
  changedLines: Set<number>,
  filePath: string,
  elements: CodeElement[],
  parentIsClass: boolean,
): void {
  // Python decorated definitions
  if (node.type === "decorated_definition") {
    for (const child of node.children) {
      if (PY_DEF_TYPES.has(child.type)) {
        handleDefinition(child, node, changedLines, filePath, elements, parentIsClass);
      }
    }
    return;
  }

  // Python definitions
  if (PY_DEF_TYPES.has(node.type)) {
    handleDefinition(node, node, changedLines, filePath, elements, parentIsClass);
    return;
  }

  // TypeScript definitions
  if (TS_DEF_TYPES.has(node.type)) {
    handleTsDefinition(node, changedLines, filePath, elements, parentIsClass);
    return;
  }

  // Python assignments
  if (node.type === "assignment" || node.type === "augmented_assignment") {
    if (overlaps(node, changedLines)) {
      const name = extractAssignmentName(node);
      if (name) {
        elements.push({
          filePath,
          name,
          kind: ElementKind.VARIABLE,
          line: node.startPosition.row + 1,
          changeType: ChangeType.MODIFIED,
        });
      }
    }
    return;
  }

  // TypeScript variable declarations
  if (TS_VAR_TYPES.has(node.type)) {
    if (overlaps(node, changedLines)) {
      const name = extractDeclaratorName(node);
      if (name) {
        elements.push({
          filePath,
          name,
          kind: ElementKind.VARIABLE,
          line: node.startPosition.row + 1,
          changeType: ChangeType.MODIFIED,
        });
      }
    }
    return;
  }

  // TypeScript export statements — walk into them
  if (node.type === "export_statement") {
    for (const child of node.children) {
      walkNode(child, changedLines, filePath, elements, parentIsClass);
    }
    return;
  }

  for (const child of node.children) {
    const childParentIsClass =
      CLASS_BODY_TYPES.has(node.type) ||
      (parentIsClass && BLOCK_TYPES.has(node.type));
    walkNode(child, changedLines, filePath, elements, childParentIsClass);
  }
}

function handleDefinition(
  defNode: TSNode,
  spanNode: TSNode,
  changedLines: Set<number>,
  filePath: string,
  elements: CodeElement[],
  parentIsClass: boolean,
): void {
  if (!overlaps(spanNode, changedLines)) {
    const isClass = defNode.type === "class_definition";
    for (const child of defNode.children) {
      walkNode(child, changedLines, filePath, elements, isClass);
    }
    return;
  }

  const name = extractName(defNode);
  if (!name) return;

  const line = defNode.startPosition.row + 1;

  if (defNode.type === "class_definition") {
    elements.push({
      filePath,
      name,
      kind: ElementKind.CLASS,
      line,
      changeType: ChangeType.MODIFIED,
    });
    for (const child of defNode.children) {
      walkNode(child, changedLines, filePath, elements, true);
    }
  } else {
    const kind = parentIsClass ? ElementKind.METHOD : ElementKind.FUNCTION;
    elements.push({
      filePath,
      name,
      kind,
      line,
      changeType: ChangeType.MODIFIED,
    });
  }
}

function handleTsDefinition(
  node: TSNode,
  changedLines: Set<number>,
  filePath: string,
  elements: CodeElement[],
  parentIsClass: boolean,
): void {
  const isClassLike = ["class_declaration", "interface_declaration", "enum_declaration"].includes(
    node.type,
  );

  if (!overlaps(node, changedLines)) {
    if (isClassLike) {
      for (const child of node.children) {
        walkNode(child, changedLines, filePath, elements, true);
      }
    }
    return;
  }

  const name = extractName(node);
  if (!name) return;

  const line = node.startPosition.row + 1;

  if (isClassLike) {
    elements.push({
      filePath,
      name,
      kind: ElementKind.CLASS,
      line,
      changeType: ChangeType.MODIFIED,
    });
    for (const child of node.children) {
      walkNode(child, changedLines, filePath, elements, true);
    }
  } else if (node.type === "method_definition") {
    elements.push({
      filePath,
      name,
      kind: ElementKind.METHOD,
      line,
      changeType: ChangeType.MODIFIED,
    });
  } else {
    const kind = parentIsClass ? ElementKind.METHOD : ElementKind.FUNCTION;
    elements.push({
      filePath,
      name,
      kind,
      line,
      changeType: ChangeType.MODIFIED,
    });
  }
}

export async function analyzeChanges(
  changedFiles: ChangedFile[],
  repoPath: string,
): Promise<CodeElement[]> {
  const elements: CodeElement[] = [];

  for (const cf of changedFiles) {
    const fullPath = `${repoPath}/${cf.path}`;

    if (cf.changeType === ChangeType.DELETED) {
      elements.push({
        filePath: cf.path,
        name: cf.path,
        kind: ElementKind.FILE,
        line: 0,
        changeType: ChangeType.DELETED,
      });
      continue;
    }

    const parser = await getParser(cf.path);
    if (!parser) continue;

    const file = Bun.file(fullPath);
    if (!(await file.exists())) continue;

    const source = await file.text();
    const tree = parser.parse(source);

    const fileElements = walkTree(tree.rootNode, cf.changedLines, cf.path);

    if (fileElements.length === 0 && cf.changedLines.size > 0) {
      elements.push({
        filePath: cf.path,
        name: cf.path,
        kind: ElementKind.FILE,
        line: Math.min(...cf.changedLines),
        changeType: cf.changeType,
      });
    } else {
      for (const elem of fileElements) {
        elem.changeType = cf.changeType;
      }
      elements.push(...fileElements);
    }
  }

  return elements;
}
