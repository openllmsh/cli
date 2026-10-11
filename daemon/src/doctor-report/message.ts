import type { TDoctorSeverity } from "@openllmsh/protocol";
import { sanitizeDoctorMessage } from "@openllmsh/protocol";

/** Objects are trusted by identity, never by a forgeable property or raw prose. */
export type TSafeDiagnosticMessage = { readonly text: string };
const trustedMessages = new WeakSet<object>();

/** Only developer-authored, interpolation-free tagged template literals qualify. */
export const safeDiagnosticMessage = (
  strings: TemplateStringsArray,
  ...values: readonly never[]
): TSafeDiagnosticMessage => {
  const literal =
    Object.isFrozen(strings) &&
    Object.isFrozen(strings.raw) &&
    strings.length === 1 &&
    values.length === 0;
  const message = Object.freeze({ text: literal ? (strings[0] ?? "") : "" });
  if (literal) trustedMessages.add(message);
  return message;
};

export const diagnosticMessageText = (
  value: unknown,
  severity: TDoctorSeverity,
): string =>
  typeof value === "object" && value !== null && trustedMessages.has(value)
    ? sanitizeDoctorMessage((value as TSafeDiagnosticMessage).text, severity)
    : sanitizeDoctorMessage("", severity);

export const localDiagnosticMessage = (
  value: string | TSafeDiagnosticMessage,
): string => (typeof value === "string" ? value : value.text);

export const isSafeDiagnosticMessage = (
  value: unknown,
): value is TSafeDiagnosticMessage =>
  typeof value === "object" && value !== null && trustedMessages.has(value);
