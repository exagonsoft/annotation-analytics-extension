export function financeFixture(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'S-fixture', start: '2026-10-12T00:00:00', end: '2026-10-18T23:59:59',
    userId: 'fixture-user-not-retained', shifts: [], expenses: [],
    deliverables: [
      { id: 'delivery-a', amount: 260, date: '2026-10-18T00:00:00', status: 4, engagementId: 'engagement-fixture',
        engagementTag: { name: 'PROJECT-FIXTURE', createdOnIp: '127.0.0.1' }, notes: 'PROJECT-FIXTURE|UI Berry 3R: Batch A- Att: 6, Rev: 0; Batch B- Att: 6, Rev: 0;',
        updatedAt: '2026-10-30T15:06:08', userId: 'fixture-user-not-retained' },
      { id: 'delivery-correction', amount: 65, date: '2026-10-18T00:00:00', status: 4, engagementId: 'engagement-fixture',
        engagementTag: { name: 'PROJECT-FIXTURE' }, notes: 'PROJECT-FIXTURE|Correction for incorrect payment in batch Batch A (Paid: 6 Att, 0 Rev | Actual: 9 Att, 0 Rev)' },
      { id: 'delivery-pending', amount: 43.34, date: '2026-10-18T00:00:00', status: 2, engagementId: 'engagement-fixture',
        engagementTag: { name: 'PROJECT-FIXTURE' }, notes: 'PROJECT-FIXTURE|Batch A- Att: 2, Rev: 1;' },
    ],
    ...overrides,
  };
}
export const financeUrl = 'https://app.greenlight.ai/ui/suppliers/S-fixture/time?start=2026-10-12T00%3A00%3A00&end=2026-10-18T23%3A59%3A59';
export function greenlightMarkup(period = 'Week of Oct 12th, 2026 - Oct 18th, 2026') {
  const row = (amount: string, status: string) => `<div class="container_rowGroup__fixture"><div class="container_row__fixture container_data__fixture">
    <div>avatar-not-retained</div><div><div>AI Trainer fixture</div><div>client-not-retained</div></div>
    <div><div>10/18/2026</div><div>${status}</div></div><div class="columns_boldColumn__fixture">${amount}</div>
    <div>PROJECT-FIXTURE</div><div><button disabled>Never click payment actions</button></div>
  </div></div>`;
  return `<div class="dashboard_time__fixture"><div class="quick_heading__fixture"><div>${period}</div><div class="quick_arrows__fixture">
    <button id="previous"><svg data-icon="chevron-left"></svg></button><button disabled><svg data-icon="chevron-right"></svg></button>
  </div></div><div class="quick_deliverables__fixture"><div class="quick_header__fixture">Deliverables (2)</div>
  ${row('$325.00', 'Processed')}${row('$43.34', 'Pending')}</div></div>
  <div class="engagement_engagement__fixture"><div class="engagement_title__fixture">AI Trainer fixture</div>
    <div class="engagement_label__fixture">Pay Rate</div><div>$21.67/project</div>
    <div class="engagement_label__fixture">Manager</div><div>manager-not-retained</div></div>`;
}
