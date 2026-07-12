const assert = require('assert');
const vscode = require('vscode');

exports.run = async function () {
  const extId = 'truesync.ue5-8-cursor';
  const ext = vscode.extensions.getExtension(extId);
  assert.ok(ext, `extension ${extId} not found`);

  await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('ue58rider.showProjectInfo'), 'showProjectInfo command missing');
  assert.ok(commands.includes('ue58rider.installCursorBridgePlugin'), 'installCursorBridgePlugin missing');
  assert.ok(commands.includes('ue58rider.debugMultiplayer'), 'debugMultiplayer missing');

  const uhtCollection = vscode.languages.getDiagnostics;
  assert.equal(typeof uhtCollection, 'function', 'diagnostics API missing');

  const ctxCommands = [
    'ue58rider.setupProject',
    'ue58rider.generateCompileCommands',
    'ue58rider.refreshUhtIntellisense',
  ];
  for (const cmd of ctxCommands) {
    assert.ok(commands.includes(cmd), `${cmd} missing`);
  }
};
