/** A script that oxc cannot parse: its templates were not looked at, so the lint must not report it as clean. */
export class ScriptParseError extends Error {
  override readonly name = "ScriptParseError";
  readonly path: string;
  readonly line: number;
  readonly column: number;

  constructor(path: string, line: number, column: number, detail: string) {
    super(detail);
    this.path = path;
    this.line = line;
    this.column = column;
  }
}
