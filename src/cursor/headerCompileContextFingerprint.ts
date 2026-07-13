import * as crypto from 'crypto';
import type { HeaderCompileContext } from '../projectModel/headerCompileContext';

export function buildHeaderContextFingerprint(context: HeaderCompileContext): string {
  const commandKey = context.compilationCommand?.join('\0') ?? '';
  const hash = crypto.createHash('sha256').update(commandKey).digest('hex').slice(0, 16);
  return `${context.provenance}:${context.translationUnit ?? ''}:${hash}`;
}
