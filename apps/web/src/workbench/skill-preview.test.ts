import { expect, it, vi } from 'vite-plus/test';
import type { SkillPreviewRequest, SkillPreviewResponse } from '@fantasy/domain';
import { currentSkillPreview, skillPreviewKey, skillWorkbenchApi } from './skill-api.ts';
import { latestSelectionGuard } from './skill-workbench-state.ts';

const ref = { id: 'character.hero', revision: 1, contentHash: `sha256:${'1'.repeat(64)}` },
  proposal: SkillPreviewRequest = {
    character: ref,
    catalog: { ...ref, id: 'catalog.skills' },
    learnedNodeIds: ['skill.a', 'skill.b'],
    enabledNodeIds: ['skill.a'],
  };
function response(input = proposal): SkillPreviewResponse {
  return {
    schemaVersion: 1,
    policyVersion: 'skill-acquisition-v1',
    proposal: input,
    eligibilityNodeIds: [],
    resolvedNodeIds: [],
    counts: { paths: 0, active: 0, passive: 0 },
    nodeReasons: [],
    reasons: [],
    reasonsTruncated: false,
    canSave: true,
  };
}
it('keys collections canonically while preserving exact character and catalog identities', () => {
  expect(
    skillPreviewKey({ ...proposal, learnedNodeIds: [...proposal.learnedNodeIds].reverse() }),
  ).toBe(skillPreviewKey(proposal));
  expect(skillPreviewKey({ ...proposal, character: { ...ref, revision: 2 } })).not.toBe(
    skillPreviewKey(proposal),
  );
});
it('ignores a delayed old selection and an aborted response using the existing selection guard', async () => {
  const guard = latestSelectionGuard();
  let release!: (value: SkillPreviewResponse) => void;
  const old = currentSkillPreview(
    {
      preview: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    proposal,
    guard.begin(),
    new AbortController().signal,
  );
  const currentProposal = { ...proposal, learnedNodeIds: [], enabledNodeIds: [] };
  expect(
    await currentSkillPreview(
      { preview: async () => response(currentProposal) },
      currentProposal,
      guard.begin(),
      new AbortController().signal,
    ),
  ).toEqual(response(currentProposal));
  release(response());
  expect(await old).toBeNull();
  const controller = new AbortController();
  controller.abort();
  expect(
    await currentSkillPreview(
      { preview: async () => response() },
      proposal,
      guard.begin(),
      controller.signal,
    ),
  ).toBeNull();
});
it('rejects a response for another exact proposal and propagates a failed request', async () => {
  const guard = latestSelectionGuard(),
    signal = new AbortController().signal;
  await expect(
    currentSkillPreview(
      { preview: async () => response({ ...proposal, character: { ...ref, revision: 2 } }) },
      proposal,
      guard.begin(),
      signal,
    ),
  ).rejects.toThrow('identity mismatch');
  await expect(
    currentSkillPreview(
      {
        preview: async () => {
          throw new Error('offline');
        },
      },
      proposal,
      guard.begin(),
      signal,
    ),
  ).rejects.toThrow('offline');
});
it('uses the validated read-only endpoint and forwards cancellation', async () => {
  const request = vi.fn(async () => Response.json(response())),
    controller = new AbortController();
  vi.stubGlobal('fetch', request);
  try {
    expect(await skillWorkbenchApi.preview(proposal, controller.signal)).toEqual(response());
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/skill-preview');
    expect(options.method).toBe('POST');
    expect(options.signal).toBe(controller.signal);
    expect(JSON.parse(String(options.body))).toEqual(proposal);
  } finally {
    vi.unstubAllGlobals();
  }
});
