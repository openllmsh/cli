import { DOCTOR_OPAQUE_ID_PATTERN } from "@openllmsh/protocol";

/** Validated opaque doctor correlation, or undefined (omit the field). */
export const opaqueDoctorCorrelation = (
  id: string | undefined,
): string | undefined =>
  id !== undefined && DOCTOR_OPAQUE_ID_PATTERN.test(id) ? id : undefined;
