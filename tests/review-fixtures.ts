export function reviewFixture(id = 7901345, overrides: Record<string, unknown> = {}) {
  return {
    id, taskId: 4010128, state: 'SUBMITTED', iterationId: 3188053, projectId: 989007,
    createdAt: 1793478535000, claimedAt: 1793554930000, endedAt: 1793555768000,
    durationInSeconds: 7, idleDurationInSeconds: 817, nextResultId: 7904586,
    currentVersionReview: { feedback: 'Score: 4\n\nSynthetic reviewer feedback for a test annotation.', annotationScore: 4, status: 'APPROVED' },
    pipeline: { id: 7001, configuration: { unrelated: 'Do not retain project configuration' } },
    annotatorProfile: { displayName: 'Synthetic fixture identity', email: 'fixture@example.test' },
    ...overrides,
  };
}
