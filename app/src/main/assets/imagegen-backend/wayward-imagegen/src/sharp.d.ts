/**
 * The slice of `sharp` this package uses, declared locally so type-checking
 * can run before the native binary is installed.
 *
 * `sharp` is a platform-specific dependency installed by the mod launcher.
 * This declaration covers the small interface used by server source files.
 * The game CLI keeps its own copy at `src/cli/images/sharp.d.ts`; this package
 * ships standalone and may import nothing from the game.
 */
declare module 'sharp' {
  interface SharpImage {
    resize(options: { width?: number; height?: number }): SharpImage
    webp(options: { quality?: number; effort?: number }): SharpImage
    toFile(path: string): Promise<unknown>
  }
  const sharp: (input: string) => SharpImage
  export default sharp
}
