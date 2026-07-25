/**
 * Declarations for the `with { type: "text" }` overlay imports in
 * `overlays.ts`. Bun resolves these natively (and inlines the bytes under
 * `bun build --compile`); TypeScript needs the module shape spelled out
 * because the extensions aren't JS/JSON.
 */

declare module "*.toml" {
  const content: string;
  export default content;
}

declare module "*.yaml" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}
