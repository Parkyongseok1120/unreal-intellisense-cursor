import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const wizard = loadTsModule('src/wizard/classWizard.ts', {
  fs: () => ({ promises: {} }),
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
});
