import * as vscode from 'vscode';

const SOURCE_LINK_RE = /([A-Za-z]:\\[^\s:]+\.(?:cpp|h|usf|ush)):(\d+)/gi;

export class UnrealLogDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;
      let match: RegExpExecArray | null;
      SOURCE_LINK_RE.lastIndex = 0;
      while ((match = SOURCE_LINK_RE.exec(text)) !== null) {
        const filePath = match[1];
        const lineNo = Number(match[2]);
        const start = new vscode.Position(line, match.index);
        const end = new vscode.Position(line, match.index + match[0].length);
        links.push(new vscode.DocumentLink(new vscode.Range(start, end), vscode.Uri.file(filePath).with({ fragment: `L${lineNo}` })));
      }
    }
    return links;
  }
}
