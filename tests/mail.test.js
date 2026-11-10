import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const {
  sesTransport, transportFromEnv, setMailTransport, resetMailTransport, mailEnabled, sendMail
} = require('../src/utils/mail');
const { MAIL_FROM } = require('../src/config/mail');
const { alertAdmins } = require('../src/utils/hostedAlerts');

const CONFIGURATION_SET = 'formamorph-mail';
const message = { from: 'a@mail.example.test', to: 'b@example.test', subject: 's', text: 't', html: 'h' };

/** Stands in for the SES client object; records every SendEmail input. */
const fakeSes = (outcome = () => Promise.resolve({ MessageId: 'm-1' })) => {
  const inputs = [];

  return { inputs, sendEmail: (input) => { inputs.push(input); return outcome(input); } };
};

const sentThrough = async (sent) => {
  const ses = fakeSes();
  await sesTransport(ses, CONFIGURATION_SET).send(sent);
  return ses.inputs[0];
};

const keys = { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret', SES_CONFIGURATION_SET: CONFIGURATION_SET };

afterEach(() => {
  resetMailTransport();
  delete process.env.STAFF_ALERT_EMAIL;
});

describe('the SES transport', () => {
  it('sends the sender, recipient, subject, both bodies and the configuration set', async () => {
    const input = await sentThrough(message);

    expect(input.FromEmailAddress).toBe(message.from);
    expect(input.Destination).toEqual({ ToAddresses: [message.to] });
    expect(input.Content.Simple.Subject.Data).toBe('s');
    expect(input.Content.Simple.Body.Text.Data).toBe('t');
    expect(input.Content.Simple.Body.Html.Data).toBe('h');
    expect(input.ConfigurationSetName).toBe(CONFIGURATION_SET);
  });

  it('sends the reply address when one is set', async () => {
    const input = await sentThrough({ ...message, replyTo: 'support@example.test' });

    expect(input.ReplyToAddresses).toEqual(['support@example.test']);
  });

  it('leaves the reply address off when none is set', async () => {
    const input = await sentThrough({ ...message, replyTo: undefined });

    expect(input).not.toHaveProperty('ReplyToAddresses');
  });

  it('sends a text-only mail without an HTML part', async () => {
    const input = await sentThrough({ ...message, html: undefined });

    expect(input.Content.Simple.Body).not.toHaveProperty('Html');
  });

  it('turns an SES refusal into a failed send that names no address', async () => {
    const refusal = Object.assign(
      new Error('Email address is not verified. The following identities failed the check: b@example.test, <a@mail.example.test>'),
      { name: 'MessageRejected', $metadata: { requestId: 'req-7' } }
    );
    const ses = fakeSes(() => Promise.reject(refusal));

    const error = await sesTransport(ses, CONFIGURATION_SET).send(message).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('MessageRejected');
    expect(error.message).toContain('req-7');
    expect(error.message).not.toContain('@');
    expect(error.cause).toBeUndefined();
  });
});

describe('choosing the transport from the environment', () => {
  it('refuses every send when no AWS key is set, and never builds a client', async () => {
    const makeClient = vi.fn();

    const { transport, missing } = transportFromEnv({}, makeClient);

    expect(missing).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SES_CONFIGURATION_SET']);
    await expect(transport.send(message)).rejects.toThrow(/Mail is off/);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('keeps mail off when the configuration set is the only key missing', async () => {
    const makeClient = vi.fn();

    const { transport, missing } = transportFromEnv({ ...keys, SES_CONFIGURATION_SET: '' }, makeClient);

    expect(missing).toEqual(['SES_CONFIGURATION_SET']);
    await expect(transport.send(message)).rejects.toThrow(/SES_CONFIGURATION_SET/);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('builds the client in us-east-2 when no region is set', () => {
    const makeClient = vi.fn(() => fakeSes());

    transportFromEnv(keys, makeClient);
    transportFromEnv({ ...keys, AWS_REGION: '' }, makeClient);

    expect(makeClient).toHaveBeenNthCalledWith(1, { accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-2' });
    expect(makeClient.mock.calls[1][0].region).toBe('us-east-2');
  });

  it('builds the client in the region the environment names', () => {
    const makeClient = vi.fn(() => fakeSes());

    transportFromEnv({ ...keys, AWS_REGION: 'eu-west-1' }, makeClient);

    expect(makeClient.mock.calls[0][0].region).toBe('eu-west-1');
  });

  it('sends with the configured set once every key is there', async () => {
    const ses = fakeSes();

    await transportFromEnv(keys, () => ses).transport.send(message);

    expect(ses.inputs[0].ConfigurationSetName).toBe(CONFIGURATION_SET);
  });

  it('starts the test process with mail off, so no test reaches AWS', async () => {
    expect(mailEnabled).toBe(false);
    await expect(sendMail(message)).rejects.toThrow(/Mail is off/);
  });
});

describe('every kind of server mail goes through SES', () => {
  let ses;

  const useFakeSes = () => {
    ses = fakeSes();
    setMailTransport(sesTransport(ses, CONFIGURATION_SET));
  };

  const expectServerMail = (input, to) => {
    expect(input.FromEmailAddress).toBe(MAIL_FROM);
    expect(input.Destination.ToAddresses).toEqual([to]);
    expect(input.ConfigurationSetName).toBe(CONFIGURATION_SET);
  };

  it('sends the verification mail', async () => {
    useFakeSes();

    const response = await fromItsOwnAddress(request(app).post('/api/auth/register').send({
      username: 'ses-verify', password: 'password123', email: 'ses-verify@example.test'
    }));

    expect(response.status).toBe(201);
    expect(ses.inputs).toHaveLength(1);
    expectServerMail(ses.inputs[0], 'ses-verify@example.test');
  });

  it('sends the password-reset mail', async () => {
    const user = createUser({ username: 'ses-reset', email: 'ses-reset@example.test' });
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    useFakeSes();

    await fromItsOwnAddress(request(app).post('/api/auth/request-password-reset').send({ account: 'ses-reset' }));

    await vi.waitFor(() => expect(ses.inputs).toHaveLength(1));
    expectServerMail(ses.inputs[0], 'ses-reset@example.test');
  });

  it('sends the staff alert mail', async () => {
    process.env.STAFF_ALERT_EMAIL = 'staff@example.test';
    useFakeSes();

    await alertAdmins({ subject: 'Formamorph AI paused', body: 'Paused.' });

    expect(ses.inputs).toHaveLength(1);
    expectServerMail(ses.inputs[0], 'staff@example.test');
    expect(ses.inputs[0].Content.Simple.Body.Text.Data).toBe('Paused.');
  });
});
