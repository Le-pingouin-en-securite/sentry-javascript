import { expect, test } from '@playwright/test';
import { waitForTransaction } from '@sentry-internal/event-proxy-server';
import axios, { AxiosError } from 'axios';

const packageJson = require('../package.json');

const authToken = process.env.E2E_TEST_AUTH_TOKEN;
const sentryTestOrgSlug = process.env.E2E_TEST_SENTRY_ORG_SLUG;
const sentryTestProject = process.env.E2E_TEST_SENTRY_TEST_PROJECT;
const EVENT_POLLING_TIMEOUT = 90_000;

test('Sends a pageload transaction', async ({ page }) => {
  const pageloadTransactionEventPromise = waitForTransaction('nextjs-13-app-dir', transactionEvent => {
    return transactionEvent?.contexts?.trace?.op === 'pageload' && transactionEvent?.transaction === '/';
  });

  await page.goto('/');

  const transactionEvent = await pageloadTransactionEventPromise;
  const transactionEventId = transactionEvent.event_id;

  await expect
    .poll(
      async () => {
        try {
          const response = await axios.get(
            `https://sentry.io/api/0/projects/${sentryTestOrgSlug}/${sentryTestProject}/events/${transactionEventId}/`,
            { headers: { Authorization: `Bearer ${authToken}` } },
          );

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
      {
        timeout: EVENT_POLLING_TIMEOUT,
      },
    )
    .toBe(200);
});

if (process.env.TEST_ENV === 'production') {
  // TODO: Fix that this is flakey on dev server - might be an SDK bug
  test('Sends a transaction for a server component', async ({ page }) => {
    const serverComponentTransactionPromise = waitForTransaction('nextjs-13-app-dir', transactionEvent => {
      return (
        transactionEvent?.contexts?.trace?.op === 'function.nextjs' &&
        transactionEvent?.transaction === 'Page Server Component (/server-component/parameter/[...parameters])'
      );
    });

    await page.goto('/server-component/parameter/1337/42');

    const transactionEvent = await serverComponentTransactionPromise;
    const transactionEventId = transactionEvent.event_id;

    expect(transactionEvent.request?.headers).toBeDefined();

    await expect
      .poll(
        async () => {
          try {
            const response = await axios.get(
              `https://sentry.io/api/0/projects/${sentryTestOrgSlug}/${sentryTestProject}/events/${transactionEventId}/`,
              { headers: { Authorization: `Bearer ${authToken}` } },
            );

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
        {
          timeout: EVENT_POLLING_TIMEOUT,
        },
      )
      .toBe(200);
  });

  test('Should not set an error status on a server component transaction when it redirects', async ({ page }) => {
    const serverComponentTransactionPromise = waitForTransaction('nextjs-13-app-dir', async transactionEvent => {
      return transactionEvent?.transaction === 'Page Server Component (/server-component/redirect)';
    });

    await page.goto('/server-component/redirect');

    expect((await serverComponentTransactionPromise).contexts?.trace?.status).not.toBe('internal_error');
  });

  test('Should set a "not_found" status on a server component transaction when notFound() is called', async ({
    page,
  }) => {
    const serverComponentTransactionPromise = waitForTransaction('nextjs-13-app-dir', async transactionEvent => {
      return transactionEvent?.transaction === 'Page Server Component (/server-component/not-found)';
    });

    await page.goto('/server-component/not-found');

    expect((await serverComponentTransactionPromise).contexts?.trace?.status).toBe('not_found');
  });
}

test('Should send a transaction for instrumented server actions', async ({ page }) => {
  const nextjsVersion = packageJson.dependencies.next;
  const nextjsMajor = Number(nextjsVersion.split('.')[0]);
  test.skip(!isNaN(nextjsMajor) && nextjsMajor < 14, 'only applies to nextjs apps >= version 14');

  const serverComponentTransactionPromise = waitForTransaction('nextjs-13-app-dir', async transactionEvent => {
    return transactionEvent?.transaction === 'serverAction/myServerAction';
  });

  await page.goto('/server-action');
  await page.getByText('Run Action').click();

  expect(await serverComponentTransactionPromise).toBeDefined();
  expect((await serverComponentTransactionPromise).extra).toMatchObject({
    'server_action_form_data.some-text-value': 'some-default-value',
    server_action_result: {
      city: 'Vienna',
    },
  });

  expect(Object.keys((await serverComponentTransactionPromise).request?.headers || {}).length).toBeGreaterThan(0);
});

test('Should set not_found status for server actions calling notFound()', async ({ page }) => {
  const nextjsVersion = packageJson.dependencies.next;
  const nextjsMajor = Number(nextjsVersion.split('.')[0]);
  test.skip(!isNaN(nextjsMajor) && nextjsMajor < 14, 'only applies to nextjs apps >= version 14');

  const serverComponentTransactionPromise = waitForTransaction('nextjs-13-app-dir', async transactionEvent => {
    return transactionEvent?.transaction === 'serverAction/notFoundServerAction';
  });

  await page.goto('/server-action');
  await page.getByText('Run NotFound Action').click();

  expect(await serverComponentTransactionPromise).toBeDefined();
  expect(await (await serverComponentTransactionPromise).contexts?.trace?.status).toBe('not_found');
});

test('Will not include spans in pageload transaction with faulty timestamps for slow loading pages', async ({
  page,
}) => {
  const pageloadTransactionEventPromise = waitForTransaction('nextjs-13-app-dir', transactionEvent => {
    return (
      transactionEvent?.contexts?.trace?.op === 'pageload' && transactionEvent?.transaction === '/very-slow-component'
    );
  });

  await page.goto('/very-slow-component');

  const pageLoadTransaction = await pageloadTransactionEventPromise;

  // @ts-expect-error We are looking at the serialized span format here
  expect(pageLoadTransaction.spans?.filter(span => span.timestamp < span.start_timestamp)).toHaveLength(0);
});
