export interface RenderedContent {
  text: string;
  type: 'text' | 'markdown';
}

export class MarkdownRenderer {
  render(content: string): RenderedContent {
    if (!content) return { text: '', type: 'text' };
    return { text: this.convert(content), type: 'markdown' };
  }

  private convert(c: string): string {
    let r = c;
    r = r.replace(/```(\w*)\n([\s\S]*?)```/g, (m: string, l: string, code: string) => '```' + (l || 'text') + '\n' + code.trim() + '\n```');
    r = r.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
    r = r.replace(/\*([^*]+)\*/g, '**$1**');
    r = r.replace(/^[-*+]\s+(.+)$/gm, '• $1');
    return r;
  }

  formatCodeBlock(code: string, lang?: string): string {
    return '```' + (lang || 'text') + '\n' + code.trim() + '\n```';
  }
}

export function createMarkdownRenderer(): MarkdownRenderer {
  return new MarkdownRenderer();
}

export function renderMarkdown(content: string): string {
  return createMarkdownRenderer().render(content).text;
}
