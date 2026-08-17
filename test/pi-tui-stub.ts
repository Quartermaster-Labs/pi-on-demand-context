// Minimal stand-in for @earendil-works/pi-tui under vitest (see vitest.config.ts).
// pi's extension loader aliases the real package at runtime; tests only need
// index.ts's import to resolve — they never render TUI output.
export class Text {
  constructor(
    public text = "",
    public padX = 0,
    public padY = 0,
    public bg?: (text: string) => string,
  ) {}
  setText(text: string) {
    this.text = text;
  }
  invalidate() {}
  render(_width: number): string[] {
    return [this.text];
  }
}
