import { $ } from "bun";
import { type ChangedFile, ChangeType } from "./models.ts";

function parseChangedLines(diffText: string): Set<number> {
  const lines = new Set<number>();
  let currentLine = 0;

  for (const rawLine of diffText.split("\n")) {
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1]!, 10);
      continue;
    }
    if (currentLine === 0) continue;

    if (rawLine.startsWith("+")) {
      lines.add(currentLine);
      currentLine++;
    } else if (rawLine.startsWith("-")) {
      // Deleted lines don't advance the new-file line counter
    } else {
      currentLine++;
    }
  }
  return lines;
}

interface DiffEntry {
  path: string;
  status: string;
  diffText: string;
}

const SUPPORTED_EXTS = [".py", ".ts", ".tsx"];

function isSupportedFile(path: string): boolean {
  return SUPPORTED_EXTS.some((ext) => path.endsWith(ext));
}

function statusToChangeType(status: string): ChangeType {
  switch (status) {
    case "A":
      return ChangeType.ADDED;
    case "D":
      return ChangeType.DELETED;
    case "R":
    case "R100":
      return ChangeType.RENAMED;
    default:
      if (status.startsWith("R")) return ChangeType.RENAMED;
      return ChangeType.MODIFIED;
  }
}

async function getDiffEntries(
  repoPath: string,
  staged: boolean,
  head: boolean,
): Promise<DiffEntry[]> {
  const diffArgs = ["git", "-C", repoPath, "diff", "--no-color", "-p", "--diff-filter=ACDMR"];

  if (staged) {
    diffArgs.push("--cached");
  } else if (head) {
    diffArgs.push("HEAD");
  }

  const nameStatusArgs = ["git", "-C", repoPath, "diff", "--name-status", "--diff-filter=ACDMR"];
  if (staged) {
    nameStatusArgs.push("--cached");
  } else if (head) {
    nameStatusArgs.push("HEAD");
  }

  const [diffResult, statusResult] = await Promise.all([
    $`${diffArgs}`.quiet().text(),
    $`${nameStatusArgs}`.quiet().text(),
  ]);

  const statusMap = new Map<string, string>();
  for (const line of statusResult.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0]!;
    // For renames, use the new path (second path)
    const path = parts.length >= 3 ? parts[2]! : parts[1]!;
    if (path) statusMap.set(path, status);
  }

  // Parse the unified diff output into per-file entries
  const entries: DiffEntry[] = [];
  const fileDiffs = diffResult.split(/^diff --git /m).slice(1);

  for (const fileDiff of fileDiffs) {
    // Extract the b/ path from the diff header
    const pathMatch = fileDiff.match(/^a\/.+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const path = pathMatch[1]!;

    const status = statusMap.get(path) ?? "M";
    entries.push({ path, status, diffText: fileDiff });
  }

  return entries;
}

async function getUntrackedFiles(repoPath: string): Promise<ChangedFile[]> {
  const result = await $`git -C ${repoPath} ls-files --others --exclude-standard`.quiet().text();
  const files: ChangedFile[] = [];

  for (const relPath of result.trim().split("\n")) {
    if (!relPath || !isSupportedFile(relPath)) continue;

    const fullPath = `${repoPath}/${relPath}`;
    const file = Bun.file(fullPath);
    if (!(await file.exists())) continue;

    const content = await file.text();
    const lineCount = content.split("\n").length;
    files.push({
      path: relPath,
      changeType: ChangeType.ADDED,
      changedLines: new Set(Array.from({ length: lineCount }, (_, i) => i + 1)),
    });
  }

  return files;
}

export async function getChangedFiles(
  repoPath: string,
  options: { staged?: boolean; head?: boolean; untracked?: boolean } = {},
): Promise<ChangedFile[]> {
  const { staged = false, head = false, untracked = false } = options;

  const entries = await getDiffEntries(repoPath, staged, head);
  const changedFiles: ChangedFile[] = [];

  for (const entry of entries) {
    if (!isSupportedFile(entry.path)) continue;

    const changeType = statusToChangeType(entry.status);
    let changedLines = parseChangedLines(entry.diffText);

    // For new files, include all lines
    if (changeType === ChangeType.ADDED && changedLines.size === 0) {
      const fullPath = `${repoPath}/${entry.path}`;
      const file = Bun.file(fullPath);
      if (await file.exists()) {
        const content = await file.text();
        const lineCount = content.split("\n").length;
        changedLines = new Set(Array.from({ length: lineCount }, (_, i) => i + 1));
      }
    }

    changedFiles.push({ path: entry.path, changeType, changedLines });
  }

  if (untracked) {
    const trackedPaths = new Set(changedFiles.map((cf) => cf.path));
    const untrackedFiles = await getUntrackedFiles(repoPath);
    for (const uf of untrackedFiles) {
      if (!trackedPaths.has(uf.path)) {
        changedFiles.push(uf);
      }
    }
  }

  return changedFiles;
}
