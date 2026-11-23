/**
 * Claude's `Elicitation` hook — an MCP server asking the user for input — as
 * the web's question panel (`user-input.requested`), and the answers back as the
 * hook's output.
 *
 * Verified against `claude` 2.1.330 (a scratch HOME, a canned Messages API and
 * a stdio MCP server that elicits): the hook gets `{mcp_server_name, message,
 * mode: "form" | "url", requested_schema}` and answers
 * `{hookSpecificOutput: {hookEventName: "Elicitation", action:
 * "accept" | "decline" | "cancel", content?}}`; the MCP server receives that
 * action and content as the elicitation result.
 *
 * Fields map to questions: an enum → its values as options; a boolean →
 * Yes / No; an array of enum → a multi-select; a number or string → free
 * text. An optional field also offers "Leave blank" (left out of `content`).
 */
import type {
  TAgentUserInputAnswers,
  TAgentUserInputQuestion,
} from "@openllmsh/sdk/protocol";

type TJson = Record<string, unknown>;

const isRecord = (value: unknown): value is TJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_FIELDS = 16;
const MAX_OPTIONS = 63;
const MAX_LABEL = 200;
export const ELICITATION_BLANK_LABEL = "Leave blank";
export const ELICITATION_CONTINUE_LABEL = "Continue";
export const ELICITATION_DECLINE_LABEL = "Decline";

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

type TOption = { readonly label: string; readonly value: unknown };

type TField = {
  readonly key: string;
  readonly kind: "enum" | "boolean" | "number" | "integer" | "string" | "multi";
  readonly options: readonly TOption[];
  readonly required: boolean;
  /** The schema's `default`, applied when an optional field is left blank. */
  readonly default?: unknown;
  /** "Leave blank" is offered (and no option of the field is called that). */
  readonly blankOffered: boolean;
};

export type TElicitation = {
  readonly questions: TAgentUserInputQuestion[];
  readonly fields: Record<string, TField>;
  /** A URL elicitation has no content: Continue accepts, anything else declines. */
  readonly url: boolean;
  /** Why this form can't be shown faithfully: it is declined, never half-accepted. */
  readonly unsupported?: string;
};

const labelOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Options of an enum-like schema (`enum`, or `oneOf`/`anyOf` of `const`s). */
const enumOptionsOf = (schema: TJson): TOption[] | null => {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value, index) => ({
      label: labelOf(typeof names[index] === "string" ? names[index] : value),
      value,
    }));
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (alternatives !== null && alternatives.length > 0) {
    const options: TOption[] = [];
    for (const alt of alternatives) {
      if (!isRecord(alt) || !("const" in alt)) return null;
      options.push({
        label: labelOf(typeof alt.title === "string" ? alt.title : alt.const),
        value: alt.const,
      });
    }
    return options;
  }
  return null;
};

/** The hook payload as questions plus what is needed to read the answers. */
export const elicitationOf = (payload: TJson): TElicitation => {
  const server =
    typeof payload.mcp_server_name === "string" ? payload.mcp_server_name : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  const heading = clip(
    [server === "" ? "An MCP server" : server, message]
      .filter((part) => part !== "")
      .join(": ") || "An MCP server asks for your input",
    4000,
  );
  if (payload.mode === "url") {
    const url = typeof payload.url === "string" ? payload.url : "";
    return {
      url: true,
      fields: {},
      questions: [
        {
          id: "f0",
          header: "Open a link",
          question: clip(url === "" ? heading : `${heading}\n${url}`, 4000),
          options: [
            { label: ELICITATION_CONTINUE_LABEL },
            { label: ELICITATION_DECLINE_LABEL },
          ],
        },
      ],
    };
  }
  const schema = isRecord(payload.requested_schema)
    ? payload.requested_schema
    : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  const questions: TAgentUserInputQuestion[] = [];
  const fields: Record<string, TField> = {};
  const entries = Object.entries(properties);
  let unsupported: string | undefined;
  if (entries.length > MAX_FIELDS)
    unsupported = `the form has ${entries.length} fields (at most ${MAX_FIELDS} can be shown)`;
  entries.slice(0, MAX_FIELDS).forEach(([key, raw], index) => {
    const spec = isRecord(raw) ? raw : {};
    const id = `f${index}`;
    const title = typeof spec.title === "string" ? spec.title : key;
    const description =
      typeof spec.description === "string" ? spec.description : undefined;
    const isRequired = required.has(key);
    let kind: TField["kind"] = "string";
    let options: TOption[] = [];
    let multi = false;
    const direct = enumOptionsOf(spec);
    if (direct !== null) {
      kind = "enum";
      options = direct;
    } else if (spec.type === "array") {
      const items = isRecord(spec.items) ? enumOptionsOf(spec.items) : null;
      if (items === null) unsupported ??= `field "${key}" is an open list`;
      else {
        kind = "multi";
        options = items;
        multi = true;
      }
    } else if (spec.type === "boolean") {
      kind = "boolean";
      options = [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ];
    } else if (spec.type === "number" || spec.type === "integer") {
      kind = spec.type;
    } else if (spec.type !== undefined && spec.type !== "string") {
      unsupported ??= `field "${key}" has an unsupported type`;
    }
    const labels = options.map((option) => option.label);
    if (
      options.length > MAX_OPTIONS ||
      labels.some((label) => label.length > MAX_LABEL || label === "") ||
      new Set(labels).size !== labels.length
    )
      unsupported ??= `field "${key}" has options that can't be told apart`;
    const blankOffered =
      !isRequired && !multi && !labels.includes(ELICITATION_BLANK_LABEL);
    fields[id] = {
      key,
      kind,
      options,
      required: isRequired,
      blankOffered,
      ...("default" in spec ? { default: spec.default } : {}),
    };
    const offered = [
      ...options.map((option) => ({ label: option.label })),
      ...(blankOffered ? [{ label: ELICITATION_BLANK_LABEL }] : []),
    ];
    questions.push({
      id,
      header: clip(title, 200),
      question: clip(
        index === 0
          ? description === undefined
            ? heading
            : `${heading}\n${description}`
          : (description ?? title),
        4000,
      ),
      ...(offered.length > 0 ? { options: offered.slice(0, 64) } : {}),
      ...(multi ? { multi_select: true } : {}),
    });
  });
  if (questions.length === 0)
    return {
      url: true,
      fields: {},
      questions: [
        {
          id: "f0",
          header: "Input requested",
          question: heading,
          options: [
            { label: ELICITATION_CONTINUE_LABEL },
            { label: ELICITATION_DECLINE_LABEL },
          ],
        },
      ],
    };
  return {
    questions,
    fields,
    url: false,
    ...(unsupported === undefined ? {} : { unsupported }),
  };
};

const asList = (answer: string | readonly string[]): readonly string[] =>
  typeof answer === "string" ? [answer] : answer;

export type TElicitationReply =
  | { readonly ok: true; readonly reply: TJson }
  | { readonly ok: false; readonly message: string };

const replyOf = (action: string, content?: TJson): TJson => ({
  hookSpecificOutput: {
    hookEventName: "Elicitation",
    action,
    ...(content === undefined ? {} : { content }),
  },
});

/**
 * The Elicitation hook's output for the web's answers, or why they can't be
 * sent: a required field left blank, a number that isn't one (an integer
 * field refuses 1.5), a value no option offers. Options match their label
 * exactly and map to the schema's own value, so nothing is retyped or merged.
 */
export const elicitationReplyOf = (
  elicitation: TElicitation,
  answers: TAgentUserInputAnswers,
): TElicitationReply => {
  if (elicitation.url) {
    const first = answers.f0;
    const said = first === undefined ? "" : (asList(first)[0] ?? "");
    return {
      ok: true,
      reply: replyOf(
        said === ELICITATION_CONTINUE_LABEL ? "accept" : "decline",
      ),
    };
  }
  const content: TJson = {};
  for (const [id, field] of Object.entries(elicitation.fields)) {
    const given = answers[id];
    const values =
      given === undefined
        ? []
        : asList(given).filter(
            (value) =>
              value.trim() !== "" &&
              !(field.blankOffered && value === ELICITATION_BLANK_LABEL),
          );
    if (values.length === 0) {
      if (field.required)
        return { ok: false, message: `"${field.key}" needs an answer.` };
      if (field.default !== undefined) content[field.key] = field.default;
      continue;
    }
    const known = (value: string): TOption | undefined =>
      field.options.find((option) => option.label === value);
    if (field.kind === "multi") {
      const picked: unknown[] = [];
      for (const value of values) {
        const option = known(value);
        if (option === undefined)
          return { ok: false, message: `"${field.key}": pick from the list.` };
        picked.push(option.value);
      }
      content[field.key] = picked;
    } else if (field.kind === "enum" || field.kind === "boolean") {
      const option = known(values[0] ?? "");
      if (option === undefined)
        return { ok: false, message: `"${field.key}": pick from the list.` };
      content[field.key] = option.value;
    } else if (field.kind === "number" || field.kind === "integer") {
      const text = (values[0] ?? "").trim();
      const n = Number(text);
      if (
        !Number.isFinite(n) ||
        (field.kind === "integer" && !Number.isInteger(n))
      )
        return {
          ok: false,
          message: `"${field.key}" must be ${field.kind === "integer" ? "a whole number" : "a number"}.`,
        };
      content[field.key] = n;
    } else content[field.key] = (values[0] ?? "").trim();
  }
  return { ok: true, reply: replyOf("accept", content) };
};

/** A dismissed elicitation (`decline`, or `cancel` to abandon the whole call). */
export const elicitationRefusalOf = (action: "decline" | "cancel"): TJson =>
  replyOf(action);
