// Noir source in `nargo fmt`'s layout, for the generators. `nargo fmt` has no
// stdin mode, and the generators run without the prover toolchain, so this
// ports the part of the pinned formatter (nargo 1.0.0-rc.3, tooling/nargo_fmt)
// that the generated files use: `use` blocks, globals, `let` and expression
// statements, calls, arrays, struct literals, `==` and `assert`. Full CI runs
// `nargo fmt --check` over the generated files, which catches any divergence.
//
// An expression is a string (identifier, path or literal), or one of `call`,
// `array`, `struct`, `eq` and `assert` below.

const MAX_WIDTH = 100;
const INDENT = 4;
// A call whose arguments are wider than this puts each on its own line.
const CALL_ARGUMENTS_WIDTH = 60;
// An array with an element wider than this puts each element on its own line.
const SHORT_ELEMENT_WIDTH = 10;

export const call = (callee, ...args) => ({ callee, args });
export const array = (elements) => ({ elements });
export const struct = (type, fields) => ({ type, fields: Object.entries(fields) });
export const eq = (lhs, rhs) => ({ lhs, operator: "==", rhs });
export const assert = (condition) => ({ assert: condition });
export const byteArray = (bytes) => array(Array.from(bytes, (byte) => `0x${byte.toString(16).padStart(2, "0")}`));

// A chunk is text, a nested group, or a layout directive. `line` breaks only
// when its group is laid out on several lines; `spaceOrLine` is a space
// otherwise; `comma` is a trailing comma written only on several lines.
const TEXT = "text";
const GROUP = "group";
const LINE = "line";
const SPACE_OR_LINE = "spaceOrLine";
const COMMA = "comma";
const INDENT_MORE = "indentMore";
const INDENT_LESS = "indentLess";
const PUSH_INDENT = "pushIndent";
const POP_INDENT = "popIndent";

let nextTag = 0;

class Group {
  chunks = [];
  oneChunkPerLine = true;
  forceMultipleLines = false;
  tag = null;
  // "regular", "list" (call, array or assert arguments) or "assign" (a value after `=`)
  kind = "regular";
  prefixWidth = 0;
  count = 0;
  forceChildrenWithSameTag = false;

  text(string) {
    if (string.length === 0) return;
    const last = this.chunks.at(-1);
    if (last?.type === TEXT) last.string += string;
    else this.chunks.push({ type: TEXT, string });
  }

  textAttachedToLastGroup(string) {
    const last = this.chunks.at(-1);
    if (last?.type === GROUP) last.group.text(string);
    else this.text(string);
  }

  group(group) {
    this.chunks.push({ type: GROUP, group });
  }

  directive(type) {
    this.chunks.push({ type });
  }

  width() {
    return this.chunks.reduce((sum, chunk) => sum + chunkWidth(chunk), 0);
  }

  hasNewlines() {
    return this.forceMultipleLines || this.chunks.some((chunk) => chunk.type === GROUP && chunk.group.hasNewlines());
  }

  firstGroup() {
    return this.chunks.find((chunk) => chunk.type === GROUP)?.group;
  }

  /** The width up to the first possible line break, and whether there is one. */
  widthUntilLine() {
    let width = 0;
    for (const chunk of this.chunks) {
      if (chunk.type === TEXT) width += chunk.string.length;
      else if (chunk.type === GROUP) {
        const [groupWidth, hitLine] = chunk.group.widthUntilLine();
        width += groupWidth;
        if (hitLine) return [width, true];
      } else if (chunk.type === LINE || chunk.type === SPACE_OR_LINE) return [width, true];
    }
    return [width, false];
  }

  /** This group with each trailing comma glued to the text before it. */
  forMultipleLines() {
    const group = Object.assign(new Group(), this, { chunks: [] });
    for (const chunk of this.chunks) {
      if (chunk.type === TEXT) group.text(chunk.string);
      else if (chunk.type === COMMA) group.addTrailingComma();
      else group.chunks.push(chunk);
    }
    return group;
  }

  addTrailingComma() {
    const last = this.chunks.at(-1);
    if (last?.type === GROUP) last.group.addTrailingComma();
    else this.text(",");
  }
}

const chunkWidth = (chunk) => {
  if (chunk.type === TEXT) return chunk.string.length;
  if (chunk.type === GROUP) return chunk.group.width();
  return chunk.type === SPACE_OR_LINE ? 1 : 0;
};

class Writer {
  buffer = "";
  lineWidth = 0;
  indentStack = [];

  constructor(indentation) {
    this.indentation = indentation;
  }

  write(string) {
    this.buffer += string;
    this.lineWidth = string.endsWith("\n") ? 0 : this.lineWidth + string.length;
  }

  writeIndentation() {
    if (this.buffer === "" || this.buffer.endsWith("\n")) this.write(" ".repeat(INDENT * this.indentation));
  }

  writeLine() {
    if (!this.buffer.endsWith("\n") && !this.buffer.endsWith(" ")) this.write("\n");
  }

  writeSpace() {
    if (!this.buffer.endsWith("\n") && !this.buffer.endsWith(" ")) this.write(" ");
  }

  trimSpaces() {
    while (this.buffer.endsWith(" ")) {
      this.buffer = this.buffer.slice(0, -1);
      this.lineWidth -= 1;
    }
  }

  format(group) {
    const total = this.lineWidth + group.width();
    if (total > MAX_WIDTH && group.kind === "list" && group.count === 1) {
      // `f(g(x))`: keep `f(` on this line if what follows up to the next break fits.
      const inner = group.firstGroup();
      if (inner?.kind === "list" && this.lineWidth + group.prefixWidth + inner.widthUntilLine()[0] <= MAX_WIDTH) {
        this.indentation -= 1;
        this.oneLine(group);
        this.indentation += 1;
        return;
      }
    }
    if (group.hasNewlines()) return this.multipleLines(group);
    if (total > MAX_WIDTH) {
      // A value after `=` that fits on the next line moves there whole.
      if (group.kind === "assign" && (this.indentation + 1) * INDENT + group.width() <= MAX_WIDTH) {
        this.trimSpaces();
        this.writeLine();
        this.indentation += 1;
        this.writeIndentation();
        this.oneLine(group);
        this.indentation -= 1;
        return;
      }
      return this.multipleLines(group);
    }
    this.oneLine(group);
  }

  oneLine(group) {
    for (const chunk of group.chunks) {
      if (chunk.type === TEXT) {
        this.writeIndentation();
        this.write(chunk.string);
      } else if (chunk.type === GROUP) this.format(chunk.group);
      else if (chunk.type === SPACE_OR_LINE) this.writeSpace();
      else this.indentDirective(chunk.type);
    }
  }

  multipleLines(original) {
    const group = original.forMultipleLines();
    let afterSpaceOrLine = false;
    let wrapped = 0;
    for (const chunk of group.chunks) {
      if (afterSpaceOrLine) {
        if (group.oneChunkPerLine || this.lineWidth + chunkWidth(chunk) + 1 > MAX_WIDTH) {
          this.writeLine();
          this.writeIndentation();
        } else {
          this.writeSpace();
        }
      }
      afterSpaceOrLine = false;
      if (chunk.type === TEXT) {
        // Text that would cross the limit mid-line wraps onto an indented line.
        if (this.lineWidth <= MAX_WIDTH && this.lineWidth + chunk.string.length > MAX_WIDTH && !this.buffer.endsWith(" ")) {
          this.writeLine();
          this.indentation += 1;
          wrapped += 1;
        }
        this.writeIndentation();
        this.write(chunk.string);
      } else if (chunk.type === GROUP) {
        if (group.forceChildrenWithSameTag && group.tag === chunk.group.tag) {
          chunk.group.forceMultipleLines = true;
          chunk.group.forceChildrenWithSameTag = true;
        }
        this.format(chunk.group);
      } else if (chunk.type === LINE) {
        this.writeLine();
        this.writeIndentation();
      } else if (chunk.type === SPACE_OR_LINE) {
        afterSpaceOrLine = true;
      } else {
        if (chunk.type === POP_INDENT) wrapped = 0;
        this.indentDirective(chunk.type);
      }
    }
    this.indentation -= wrapped;
  }

  indentDirective(type) {
    if (type === INDENT_MORE) this.indentation += 1;
    else if (type === INDENT_LESS) this.indentation -= 1;
    else if (type === PUSH_INDENT) this.indentStack.push(this.indentation);
    else if (type === POP_INDENT) this.indentation = this.indentStack.pop();
  }
}

/** Lay out `group` starting a line at `indentation` levels. */
function render(group, indentation) {
  const writer = new Writer(indentation);
  writer.writeIndentation();
  const saved = writer.indentation;
  writer.format(group);
  writer.indentation = saved;
  return writer.buffer;
}

function expression(value, group) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    group.text(String(value));
  } else if ("callee" in value) {
    group.group(callGroup(value));
  } else if ("elements" in value) {
    if (value.elements.length === 0) group.text("[]");
    else group.group(arrayGroup(value.elements));
  } else if ("type" in value) {
    group.group(structGroup(value));
  } else if ("operator" in value) {
    group.group(infixGroup(value));
  } else if ("assert" in value) {
    group.group(listGroup("assert(", [value.assert]).group);
  } else {
    throw new Error(`not a Noir expression: ${JSON.stringify(value)}`);
  }
}

/** Comma-separated `items` between a `line` each side; the widest item's width. */
function commaSeparated(items, group) {
  if (items.length === 0) throw new Error("empty Noir list");
  group.directive(INDENT_MORE);
  group.directive(LINE);
  let widest = 0;
  items.forEach((item, index) => {
    if (index > 0) {
      group.textAttachedToLastGroup(",");
      group.directive(SPACE_OR_LINE);
    }
    const before = group.chunks.length;
    expression(item, group);
    widest = Math.max(widest, group.chunks.slice(before).reduce((sum, chunk) => sum + chunkWidth(chunk), 0));
  });
  group.directive(COMMA);
  group.directive(INDENT_LESS);
  group.directive(LINE);
  return widest;
}

function listGroup(prefix, items) {
  const group = new Group();
  group.text(prefix);
  group.kind = "list";
  group.prefixWidth = prefix.length;
  group.count = items.length;
  const widest = commaSeparated(items, group);
  group.text(prefix.endsWith("[") ? "]" : ")");
  return { group, widest };
}

function callGroup({ callee, args }) {
  const { group } = listGroup(`${callee}(`, args);
  const argumentsWidth = group.width() - `${callee}()`.length;
  if (argumentsWidth > CALL_ARGUMENTS_WIDTH) group.forceMultipleLines = true;
  return group;
}

function arrayGroup(elements) {
  const { group, widest } = listGroup("[", elements);
  group.oneChunkPerLine = widest > SHORT_ELEMENT_WIDTH;
  return group;
}

function structGroup({ type, fields }) {
  const group = new Group();
  group.text(`${type} {`);
  group.directive(INDENT_MORE);
  group.directive(SPACE_OR_LINE);
  fields.forEach(([name, value], index) => {
    if (index > 0) {
      group.textAttachedToLastGroup(",");
      group.directive(SPACE_OR_LINE);
    }
    group.text(`${name}: `);
    expression(value, group);
  });
  group.directive(COMMA);
  group.directive(INDENT_LESS);
  group.directive(SPACE_OR_LINE);
  group.text("}");
  return group;
}

function infixGroup({ lhs, operator, rhs }) {
  const group = new Group();
  group.tag = nextTag++;
  group.forceChildrenWithSameTag = true;
  group.directive(PUSH_INDENT);
  expression(lhs, group);
  group.directive(INDENT_MORE);
  group.directive(SPACE_OR_LINE);
  group.text(`${operator} `);
  expression(rhs, group);
  group.directive(POP_INDENT);
  return group;
}

/** `[let] <target> = value;` with the value laid out as `nargo fmt` lays out an assigned value. */
function assignment(prefix, target, value) {
  const group = new Group();
  group.text(prefix);
  const pattern = new Group();
  pattern.text(target);
  group.group(pattern);
  group.text(" = ");
  const assigned = new Group();
  assigned.kind = "assign";
  expression(value, assigned);
  assigned.textAttachedToLastGroup(";");
  group.group(assigned);
  return group;
}

/** A top-level `[pub ]global name: type = value;`. */
export function noirGlobal(name, type, value, { pub = false } = {}) {
  const group = new Group();
  if (pub) group.text("pub ");
  group.group(assignment("global ", `${name}: ${type}`, value));
  return `${render(group, 0)}\n`;
}

/**
 * One statement of a function body, indented one level: `let` when `name` is
 * given, else `value` as an expression statement ending in `;` unless it is
 * the body's trailing value.
 */
export function noirStatement(value, { name, type, trailing = false } = {}) {
  if (name !== undefined) return render(assignment("let ", type === undefined ? name : `${name}: ${type}`, value), 1);
  const group = new Group();
  expression(value, group);
  if (!trailing) group.textAttachedToLastGroup(";");
  return render(group, 1);
}

/** A `#[test]` function whose body is `statements` (from `noirStatement`). */
export const noirTest = (name, statements) => `#[test]\nfn ${name}() {\n${statements.map((line) => `${line}\n`).join("")}}\n`;

// `use` ordering: `self`, then `crate`, then plain segments case-insensitively.
function compareSegments(a, b) {
  const rank = (segment) => (segment === "self" ? 0 : segment === "crate" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const [lowerA, lowerB] = [a.toLowerCase(), b.toLowerCase()];
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// An import tree is a sorted array of [segment, subtree]; each imported name ends in "self".
function compareTrees(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compareSegments(a[index][0], b[index][0]) || compareTrees(a[index][1], b[index][1]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function importTree(path, names) {
  const leaves = [...new Set(names)].sort(compareSegments).map((name) => [name, [["self", []]]]);
  return path.split("::").reduceRight((tree, segment) => [[segment, tree]], leaves);
}

// Join each run of single-child segments, as `nargo fmt` does before writing.
function simplify(tree) {
  return tree.map(([segment, subtree]) => {
    const simple = simplify(subtree);
    if (simple.length !== 1) return [segment, simple];
    const [child, grandchildren] = simple[0];
    return [child === "self" ? segment : `${segment}::${child}`, grandchildren];
  });
}

function importGroup([segment, subtree]) {
  const group = new Group();
  group.text(segment);
  if (subtree.length === 0) return group;
  if (subtree.every(([, children]) => children.length === 0)) group.oneChunkPerLine = false;
  group.text("::{");
  group.directive(INDENT_MORE);
  group.directive(LINE);
  subtree.forEach((entry, index) => {
    if (index > 0) {
      group.textAttachedToLastGroup(",");
      group.directive(SPACE_OR_LINE);
    }
    group.group(importGroup(entry));
  });
  group.directive(COMMA);
  group.directive(INDENT_LESS);
  group.directive(LINE);
  group.text("}");
  return group;
}

/**
 * A block of `use` statements, sorted and laid out as `nargo fmt` does.
 * `imports` maps each module path to the names imported from it.
 */
export function noirUses(imports) {
  const trees = [...imports].map(([path, names]) => importTree(path, names)).sort(compareTrees);
  return trees.map((tree) => {
    const group = new Group();
    group.text("use ");
    group.group(importGroup(simplify(tree)[0]));
    group.textAttachedToLastGroup(";");
    return `${render(group, 0)}\n`;
  }).join("");
}
