import { UI_CASES } from '../../../e2e/contract.ts';

export function uiResults(
  cases: readonly string[] = UI_CASES,
  browsers: readonly string[] = ['chromium'],
) {
  return {
    errors: [],
    suites: [
      {
        specs: cases.map((title) => ({
          id: `stable-${title}`,
          title,
          tests: browsers.map((name) => ({
            projectName: name,
            expectedStatus: 'passed',
            results: [
              {
                retry: 0,
                status: 'passed',
                attachments: [
                  {
                    name: 'browser-identity',
                    body: Buffer.from(JSON.stringify({ name, version: '123.0' })).toString(
                      'base64',
                    ),
                    path: undefined as string | undefined,
                  },
                ],
              },
            ],
          })),
        })),
      },
    ],
  };
}
