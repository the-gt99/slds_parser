export interface TextTranslationProvider {
  readonly code: string;
  readonly version: string;
  translate(text: string, sourceLocale: string, targetLocale: string): Promise<string>;
}
