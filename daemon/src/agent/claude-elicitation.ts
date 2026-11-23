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
};

export type TElicitation = {
  readonly questions: TAgentUserInputQuestion[];
  readonly fields: Record<string, TField>;
  /** A URL elicitation has no content: Continue accepts, anything else declines. */
  readonly url: boolean;
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
  Object.entries(properties)
    .slice(0, MAX_FIELDS)
    .forEach(([key, raw], index) => {
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
      } else if (spec.type === "array" && isRecord(spec.items)) {
        const items = enumOptionsOf(spec.items);
        if (items !== null) {
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
      }
      options = options.slice(0, MAX_OPTIONS).map((option) => ({
        ...option,
        label: clip(option.label, 200),
      }));
      fields[id] = { key, kind, options, required: isRequired };
      const offered = [
        ...options.map((option) => ({ label: option.label })),
        ...(!isRequired && !multi ? [{ label: ELICITATION_BLANK_LABEL }] : []),
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
        ...(offered.length > 0 ? { options: offered } : {}),
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
  return { questions, fields, url: false };
};

const asList = (answer: string | readonly string[]): readonly string[] =>
  typeof answer === "string" ? [answer] : answer;

const normalize = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

const typedValueOf = (field: TField, text: string): unknown => {
  const trimmed = text.trim();
  if (field.kind === "number" || field.kind === "integer") {
    const n = Number(trimmed);
    return trimmed !== "" && Number.isFinite(n) ? n : trimmed;
  }
  return trimmed;
};

/** The Elicitation hook's output for the web's answers. */
export const elicitationReplyOf = (
  elicitation: TElicitation,
  answers: TAgentUserInputAnswers,
): TJson => {
  const reply = (action: string, content?: TJson): TJson => ({
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action,
      ...(content === undefined ? {} : { content }),
    },
  });
  if (elicitation.url) {
    const first = answers.f0;
    const said = first === undefined ? "" : (asList(first)[0] ?? "");
    return reply(
      normalize(said) === normalize(ELICITATION_CONTINUE_LABEL)
        ? "accept"
        : "decline",
    );
  }
  const content: TJson = {};
  for (const [id, field] of Object.entries(elicitation.fields)) {
    const given = answers[id];
    if (given === undefined) continue;
    const values = asList(given).filter(
      (value) => normalize(value) !== normalize(ELICITATION_BLANK_LABEL),
    );
    if (values.length === 0) continue;
    const byLabel = (value: string): unknown => {
      const option = field.options.find(
        (candidate) => normalize(candidate.label) === normalize(value),
      );
      return option === undefined ? typedValueOf(field, value) : option.value;
    };
    content[field.key] =
      field.kind === "multi" ? values.map(byLabel) : byLabel(values[0] ?? "");
  }
  return reply("accept", content);
};

/** A dismissed elicitation (`decline`, or `cancel` to abandon the whole call). */
export const elicitationRefusalOf = (action: "decline" | "cancel"): TJson => ({
  hookSpecificOutput: { hookEventName: "Elicitation", action },
});
