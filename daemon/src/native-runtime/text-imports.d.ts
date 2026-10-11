/**
 * Declarations for `with { type: "text" }` embeds under native-runtime.
 * Bun inlines these under `bun build --compile`; TypeScript needs the shape.
 *
 * Use non-JS extensions here. A real `.cjs` / `.js` file would be typed via
 * `allowJs` from its CommonJS exports and would ignore this ambient module.
 */
declare module "*.txt" {
  const content: string;
  export default content;
}
