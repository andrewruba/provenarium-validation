import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    deletePassword() {
      return backend.remove();
    }
  },
}));

import { forgetProviderKey } from '../src/credentials.js';

afterEach(() => {
  backend.remove.mockReset();
});

describe('provider credential removal', () => {
  it('reports success after the backend removes an entry', async () => {
    await expect(forgetProviderKey('openai')).resolves.toBeUndefined();
    expect(backend.remove).toHaveBeenCalledOnce();
  });

  it('treats an explicitly missing entry as already removed', async () => {
    backend.remove.mockImplementation(() => {
      throw new Error('No matching entry found in secure storage');
    });
    await expect(forgetProviderKey('anthropic')).resolves.toBeUndefined();
  });

  it('does not claim removal when the backend is unavailable or locked', async () => {
    for (const message of [
      'Secret Service backend not found',
      'D-Bus unavailable',
      'Keychain locked; SENTINEL-secret',
    ]) {
      backend.remove.mockImplementation(() => {
        throw new Error(message);
      });
      try {
        await forgetProviderKey('openai');
        throw new Error('Expected removal to fail');
      } catch (error) {
        expect((error as Error).message).toContain('could not be removed');
        expect((error as Error).message).not.toContain('SENTINEL-secret');
      }
    }
  });
});
