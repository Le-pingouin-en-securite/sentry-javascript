import { expect, test } from '@playwright/test';
import axios, { AxiosError } from 'axios';
import { waitForError } from '../event-proxy-server';

const authToken = process.env.E2E_TEST_AUTH_TOKEN;
const sentryTestOrgSlug = process.env.E2E_TEST_SENTRY_ORG_SLUG;
const sentryTestProject = process.env.E2E_TEST_SENTRY_TEST_PROJECT;
const EVENT_POLLING_TIMEOUT = 90_000;

test('Sends captured error to Sentry', async ({ baseURL }) => {
  const { data } = await axios.get(`${baseURL}/test-error`);
  const { exceptionId } = data;

  const url = `https://sentry.io/api/0/projects/${sentryTestOrgSlug}/${sentryTestProject}/events/${exceptionId}/`;

  console.log(`Polling for error eventId: ${exceptionId}`);

  await expect
    .poll(
      async () => {
        try {
          const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${authToken}` },
          });

          return response.status;
        } catch (e) {
          if (e instanceof AxiosError && e.response) {
            if (e.response.status !== 404) {
              throw e;
            } else {
              return e.response.status;
            }
          } else {
            throw e;
          }
        }
      },
      { timeout: EVENT_POLLING_TIMEOUT },
    )
    .toBe(200);
});

test('Sends exception to Sentry', async ({ baseURL }) => {
  const errorEventPromise = waitForError('node-nestjs-app', event => {
    return !event.type && event.exception?.values?.[0]?.value === 'This is an exception';
  });

  try {
    axios.get(`${baseURL}/test-exception`);
  } catch {
    // this results in an error, but we don't care - we want to check the error event
  }

  const errorEvent = await errorEventPromise;

  expect(errorEvent.exception?.values).toHaveLength(1);
  expect(errorEvent.exception?.values?.[0]?.value).toBe('This is an exception');

  expect(errorEvent.request).toEqual({
    method: 'GET',
    cookies: {},
    headers: expect.any(Object),
    url: 'http://localhost:3030/test-exception',
  });

  expect(errorEvent.transaction).toEqual('GET /test-exception');

  expect(errorEvent.contexts?.trace).toEqual({
    trace_id: expect.any(String),
    span_id: expect.any(String),
  });
});
