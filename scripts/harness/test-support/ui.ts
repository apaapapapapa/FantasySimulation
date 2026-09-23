import { UI_CASES } from '../../../e2e/contract.ts';

export function uiResults(cases: readonly string[] = UI_CASES) {
  return {
    errors: [],
    suites: [
      {
        specs: cases.map((title) => ({
          id: `stable-${title}`,
          title,
          tests: [
            {
              projectName: 'chromium',
              expectedStatus: 'passed',
              results: [
                {
                  retry: 0,
                  status: 'passed',
                  attachments: [
                    {
                      name: 'browser-identity',
                      body: Buffer.from('{"name":"chromium","version":"123.0"}').toString('base64'),
                      path: undefined as string | undefined,
                    },
                  ],
                },
              ],
            },
          ],
        })),
      },
    ],
  };
}
