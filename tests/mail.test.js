import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resendTransport } = require('../src/utils/mail');

const message = { from: 'a@mail.example.test', to: 'b@example.test', subject: 's', text: 't', html: 'h' };

const postedBody = async (sent) => {
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  await resendTransport('key').send(sent);
  return JSON.parse(fetch.mock.calls[0][1].body);
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('the Resend transport', () => {
  it('sends the reply address as reply_to', async () => {
    const body = await postedBody({ ...message, replyTo: 'support@example.test' });

    expect(body.reply_to).toBe('support@example.test');
  });

  it('leaves reply_to off when no reply address is set', async () => {
    const body = await postedBody({ ...message, replyTo: undefined });

    expect(body).not.toHaveProperty('reply_to');
    expect(body.from).toBe(message.from);
  });
});
