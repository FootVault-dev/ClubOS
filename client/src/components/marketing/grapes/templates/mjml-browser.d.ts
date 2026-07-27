// mjml-browser ships no type declarations and no `types` field. This ambient
// shim types the default export so the gallery can compile a template's MJML to
// HTML in-browser for the live mini-previews. (mjml-browser is already present —
// it's the compiler grapesjs-mjml uses under the hood — so this adds no new dep.)
declare module "mjml-browser" {
  interface MJMLParseError {
    line: number;
    message: string;
    tagName: string;
    formattedMessage: string;
  }
  interface MJMLParseResults {
    html: string;
    errors: MJMLParseError[];
  }
  interface MJMLParsingOptions {
    validationLevel?: "strict" | "soft" | "skip";
    minify?: boolean;
    beautify?: boolean;
    keepComments?: boolean;
    fonts?: Record<string, string>;
    [key: string]: unknown;
  }
  export default function mjml2html(
    mjml: string,
    options?: MJMLParsingOptions,
  ): MJMLParseResults;
}
