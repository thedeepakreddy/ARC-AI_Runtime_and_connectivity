import { describe, expect, it } from 'vitest';
import { defaultWorkspaceName } from '../src/auth/workspace.js';

describe('defaultWorkspaceName', () => {
  it('names the workspace after the person', () => {
    expect(defaultWorkspaceName('maya@example.com')).toBe("Maya's workspace");
    expect(defaultWorkspaceName('maya.lee+test@example.com')).toBe("Maya's workspace");
    expect(defaultWorkspaceName('j_doe@example.com')).toBe("J's workspace");
    expect(defaultWorkspaceName('1234@example.com')).toBe('My workspace');
    expect(defaultWorkspaceName('ünal@example.com')).toBe("Ünal's workspace");
  });
});
