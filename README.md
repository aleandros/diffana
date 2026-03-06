# diffana

Analyze git diffs to identify affected code elements (functions, classes, methods, variables) using tree-sitter.

Supports Python, TypeScript, and TSX files.

## Install

```bash
bun install
```

## Usage

```bash
# Analyze unstaged changes (working tree vs index)
bun run index.ts [repo_path]

# Analyze staged changes (index vs HEAD)
bun run index.ts --staged [repo_path]

# Analyze all changes vs HEAD
bun run index.ts --head [repo_path]

# Include untracked files
bun run index.ts --untracked [repo_path]
```

Example output:

```
File              Element        Kind      Line  Change
----------------  -------------  --------  ----  --------
src/analyzer.ts   walkNode       function  125   modified
src/models.ts     ChangeType     class     1     added
```

## Build

Build a self-contained executable:

```bash
bun run build
```

This produces a single self-contained binary at `dist/diffana` with all WASM grammars embedded.
