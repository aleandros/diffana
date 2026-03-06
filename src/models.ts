export enum ChangeType {
  ADDED = "added",
  DELETED = "deleted",
  MODIFIED = "modified",
  RENAMED = "renamed",
}

export enum ElementKind {
  FUNCTION = "function",
  CLASS = "class",
  METHOD = "method",
  VARIABLE = "variable",
  FILE = "file",
}

export interface ChangedFile {
  path: string;
  changeType: ChangeType;
  changedLines: Set<number>;
}

export interface CodeElement {
  filePath: string;
  name: string;
  kind: ElementKind;
  line: number;
  changeType: ChangeType;
}
