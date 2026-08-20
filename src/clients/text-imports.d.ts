/**
 * Declarations for the `with { type: "text" }` overlay imports in
 * `overlays.ts` / `hooks.ts`. Bun resolves these natively (and inlines the
 * bytes under `bun build --compile`); TypeScript needs the module shape
 * spelled out because the extensions aren't JS/JSON.
 *
 * `.json` overlays deliberately have NO declaration here — TypeScript resolves
 * those through `resolveJsonModule` and types them as the parsed object, which
 * `overlays.ts` narrows explicitly (see the `asText` note there).
 */

declare module "*.toml" {
  const content: string;
  export default content;
}

declare module "*.yaml" {
  const content: string;
  export default content;
}

declare module "*.yml" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.sh" {
  const content: string;
  export default content;
}
