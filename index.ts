import { resolve } from "path";
import { parseArgs } from "util";
import { analyzeChanges } from "./src/analyzer.ts";
import { getChangedFiles } from "./src/diff.ts";
import { formatTable } from "./src/formatter.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    staged: { type: "boolean", default: false },
    head: { type: "boolean", default: false },
    untracked: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  console.log(`diffana - Analyze git diffs to identify affected code elements.

Usage: bun run index.ts [options] [repo_path]

Arguments:
  repo_path     Path to the git repository (default: current directory)

Options:
  --staged      Analyze staged changes (index vs HEAD)
  --head        Analyze all changes vs HEAD (working tree vs HEAD)
  --untracked   Include untracked files in the analysis
  -h, --help    Show this help message`);
  process.exit(0);
}

if (values.staged && values.head) {
  console.error("Error: --staged and --head are mutually exclusive");
  process.exit(1);
}

const repoPath = resolve(positionals[0] ?? ".");

const changedFiles = await getChangedFiles(repoPath, {
  staged: values.staged,
  head: values.head,
  untracked: values.untracked,
});

if (changedFiles.length === 0) {
  process.exit(0);
}

const elements = await analyzeChanges(changedFiles, repoPath);

if (elements.length === 0) {
  process.exit(0);
}

console.log(formatTable(elements));
