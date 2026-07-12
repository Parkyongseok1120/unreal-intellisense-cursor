import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const wizard = loadTsModule('src/wizard/classWizard.ts', {
  fs: () => ({ promises: {} }),
  '../platform/workspaceMutation': () => ({
    mutateText: async () => {},
    runWithTransaction: async (_root, fn) => fn({ writeText: async () => {} }),
  }),
});

describe('classWizard', () => {
  it('renders UINTERFACE with U prefix and I implementor', () => {
    const header = wizard.renderWizardHeader({
      className: 'Example',
      kind: 'Interface',
      moduleName: 'GameModule',
      apiMacro: 'GAMEMODULE_API',
    });
    assert.match(header, /UINTERFACE[\s\S]*class GAMEMODULE_API UExample : public UInterface/);
    assert.match(header, /class GAMEMODULE_API IExample/);
    assert.doesNotMatch(header, /UINTERFACE[\s\S]*IExample : public UInterface/);
  });

  it('UserWidget only adds UMG dependency', () => {
    assert.deepEqual(wizard.moduleExtraDependencies('UserWidget'), ['UMG']);
  });

  it('previewBuildCsPatch shows UMG insertion', () => {
    const content = `using UnrealBuildTool;\npublic class Game : ModuleRules\n{\n\tpublic Game(ReadOnlyTargetRules Target) : base(Target)\n\t{\n\t\tPublicDependencyModuleNames.AddRange(new string[] {\n\t\t\t"Core",\n\t\t});\n\t}\n}`;
    const patch = wizard.previewBuildCsPatch(content, ['UMG']);
    assert.ok(patch);
    assert.match(patch.preview, /UMG/);
    assert.match(patch.newContent, /"UMG"/);
  });

  it('getMissingWizardDependencies detects UMG when absent', async () => {
    const fsMock = {
      promises: {
        readFile: async () =>
          'PublicDependencyModuleNames.AddRange(new string[] { "Core" });',
      },
    };
    const wizardLocal = loadTsModule('src/wizard/classWizard.ts', {
      fs: () => fsMock,
      '../platform/workspaceMutation': () => ({
        mutateText: async () => {},
        runWithTransaction: async (_root, fn) => fn({ writeText: async () => {} }),
      }),
    });
    const missing = await wizardLocal.getMissingWizardDependencies(
      { projectRoot: 'C:/P', name: 'P', uprojectPath: 'C:/P/P.uproject', modules: [] },
      { className: 'MyWidget', kind: 'UserWidget', moduleName: 'Game', apiMacro: 'GAME_API' },
    );
    assert.deepEqual(missing, ['UMG']);
  });
});
