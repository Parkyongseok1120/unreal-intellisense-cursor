import * as vscode from 'vscode';

const CHANNEL_NAME = 'UE5_8 Cursor';

export function createOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel(CHANNEL_NAME);
}
