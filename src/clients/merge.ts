/**
 * Pure merge primitives for the runtime client overlays — no fs, no network,
 * no process state, so every rule here is unit-testable in isolation
 * (`tests/cli/client-merge.test.ts`).
 *
 * The contract every helper upholds: the USER's document is the base and is
 * preserved except where OpenLLM owns a key. Nothing here writes anything;
 * callers decide where the merged bytes go (a run dir for session clients, the
 * host file for always-on clients).
 */

/** Placeholder names the overlays may reference (`{{NAME}}`). */
export type TOverlayVars = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Substitute `{{NAME}}` placeholders. An unknown placeholder is a programming
 * error (an overlay referencing a var the caller didn't supply), so it throws
 * rather than shipping a literal `{{…}}` into a client config.
 */
export const substitute = (text: string, vars: TOverlayVars): string =>
  text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`overlay placeholder {{${name}}} has no value`);
    }
    return value;
  });

/**
 * Substitute placeholders that stand in for a whole JSON value rather than a
 * string — `"models": "{{MODELS}}"` becomes `"models": { … }`. Done as a
 * separate pass BEFORE `substitute` so the injected JSON isn't itself scanned
 * for placeholders.
 */
export const substituteJsonValue = (
  text: string,
  name: string,
  json: string,
): string => text.replaceAll(`"{{${name}}}"`, json);

export type TJsonObject = { [key: string]: unknown };

const isPlainObject = (value: unknown): value is TJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Recursive object merge — `overlay` wins on every leaf it defines, the user's
 * other keys are preserved untouched. Arrays are REPLACED, not concatenated
 * (an overlay array is a complete statement of what OpenLLM wants; appending
 * would duplicate entries on a second merge).
 */
export const deepMerge = (base: unknown, overlay: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: TJsonObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
};

/**
 * Parse JSON that may carry `//` / `/* *\/` comments (OpenCode accepts
 * `.jsonc`). Strips comments outside string literals, then parses. Returns
 * null when the text isn't valid JSON at all — callers treat that as
 * "refuse to touch this file" rather than overwriting it.
 */
export const parseJsonLoose = (text: string): TJsonObject | null => {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  try {
    const parsed: unknown = JSON.parse(out);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Render a scalar as a TOML value. */
const tomlValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isPlainObject(value)) {
    const inner = Object.entries(value)
      .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  return JSON.stringify(String(value));
};

/** Quote a TOML key when it isn't a bare key. */
const tomlKey = (key: string): string =>
  /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);

/**
 * Flatten a parsed TOML document to dotted `key=value` pairs — the shape
 * Codex's `-c key=value` override flag takes. Nested tables become dotted
 * paths; leaf arrays/inline tables are rendered as TOML values.
 *
 *   { model: "ultra", model_providers: { openllm: { name: "OpenLLM" } } }
 *     → ['model="ultra"', 'model_providers.openllm.name="OpenLLM"']
 */
export const tomlLeaves = (doc: TJsonObject, prefix = ""): string[] => {
  const out: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix === "" ? tomlKey(key) : `${prefix}.${tomlKey(key)}`;
    if (isPlainObject(value)) out.push(...tomlLeaves(value, path));
    else out.push(`${path}=${tomlValue(value)}`);
  }
  return out;
};

/**
 * Serialize a parsed TOML document back to text. Top-level scalars first (TOML
 * requires them before any table header), then one `[table]` per nested
 * object, depth-first with quoted keys where needed.
 */
export const parseYaml = (text: string): TJsonObject | null => {
  try {
    const parsed: unknown = Bun.YAML.parse(text);
    if (!isPlainObject(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const serializeYaml = (doc: TJsonObject): string => {
  const raw = Bun.YAML.stringify(doc);
  return raw.endsWith("\n") ? raw : `${raw}\n`;
};

export const serializeToml = (doc: TJsonObject): string => {
  const scalars: string[] = [];
  const tables: string[] = [];
  const walk = (obj: TJsonObject, path: readonly string[]): void => {
    const leaves: string[] = [];
    const nested: [string, TJsonObject][] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (isPlainObject(value)) nested.push([key, value]);
      else leaves.push(`${tomlKey(key)} = ${tomlValue(value)}`);
    }
    if (path.length === 0) {
      scalars.push(...leaves);
    } else if (leaves.length > 0) {
      tables.push(`[${path.map(tomlKey).join(".")}]\n${leaves.join("\n")}`);
    } else {
      tables.push(`[${path.map(tomlKey).join(".")}]`);
    }
    for (const [key, value] of nested) walk(value, [...path, key]);
  };
  walk(doc, []);
  const parts = [scalars.join("\n"), tables.join("\n\n")].filter(
    (p) => p.length > 0,
  );
  return `${parts.join("\n\n")}\n`;
};

/**
 * Managed-region replace/insert for line-oriented text formats (Raycast's
 * `providers.yaml`). Replaces an existing `begin…end` region in place, else
 * appends the block. Returns the new text; `null` when the region markers are
 * unbalanced (a hand-mangled file) so the caller can refuse rather than
 * corrupt it.
 */
export const upsertRegion = (
  text: string,
  begin: string,
  end: string,
  block: string,
): string | null => {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b >= 0 && e < b) return null;
  if (b < 0 && e >= 0) return null;
  const body = `${begin}\n${block.replace(/\n*$/, "")}\n${end}`;
  if (b >= 0 && e > b) {
    return text.slice(0, b) + body + text.slice(e + end.length);
  }
  return `${text.replace(/\n*$/, "\n")}${body}\n`;
};

/**
 * Remove a managed region. Null when the markers are unbalanced. Collapses the
 * blank gap the removal leaves behind and normalizes the file to exactly one
 * trailing newline, so a remove→apply→remove cycle returns the original bytes
 * rather than accreting blank lines at EOF.
 */
export const removeRegion = (
  text: string,
  begin: string,
  end: string,
): string | null => {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b < 0 && e < 0) return text;
  if (b < 0 || e < b) return null;
  const stripped = (text.slice(0, b) + text.slice(e + end.length)).replace(
    /\n{3,}/g,
    "\n\n",
  );
  if (stripped.trim().length === 0) return "";
  return stripped.replace(/\n*$/, "\n");
};
