import { CLINIC, RATING_LABELS } from '@stellar/shared';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Shared branded wrapper so every notification looks consistent. */
export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f1f7f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12302f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d7e7e6">
<tr><td style="background:#0f766e;color:#ffffff;padding:18px 24px;font-size:18px;font-weight:600">${escapeHtml(CLINIC.name)}</td></tr>
<tr><td style="padding:24px">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#5b7473;border-top:1px solid #e3eeee">
This message contains confidential patient information. Do not forward it outside the clinic.
</td></tr>
</table></td></tr></table></body></html>`;
}

export interface ComplaintNotificationData {
  reference: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  rating: number;
  details: string;
  createdAt: number;
  dashboardUrl: string;
  includeDetails: boolean;
}

export function renderComplaintNotification(d: ComplaintNotificationData): RenderedEmail {
  const when = new Date(d.createdAt).toUTCString();
  const ratingText = `${d.rating}/5 (${RATING_LABELS[d.rating] ?? ''})`;
  // Subject carries no patient identifiers: it is visible in lock screens and mail logs.
  const subject = `Negative review ${d.reference} – ${d.rating}/5 stars`;

  const rows: Array<[string, string]> = [
    ['Reference', d.reference],
    ['Received', when],
    ['Rating', ratingText],
  ];
  if (d.includeDetails) {
    rows.push(['Patient', `${d.firstName} ${d.lastName}`], ['Email', d.email], ['Phone', d.phone]);
  }

  const text = [
    `A patient left a negative review on the ${CLINIC.name} portal and shared their contact details.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(d.includeDetails ? ['', 'Review:', d.details] : []),
    '',
    `Open in dashboard: ${d.dashboardUrl}`,
  ].join('\n');

  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#5b7473;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const detailsHtml = d.includeDetails
    ? `<h2 style="font-size:15px;margin:20px 0 8px">Patient review</h2>
       <div style="white-space:pre-wrap;background:#f6fafa;border-radius:10px;padding:14px;border:1px solid #e3eeee">${escapeHtml(d.details)}</div>`
    : '<p style="color:#5b7473">Contact details and the full complaint are available in the dashboard.</p>';

  const html = layout(
    subject,
    `<h1 style="font-size:20px;margin:0 0 12px">New private complaint</h1>
     <p style="margin:0 0 16px">A patient submitted a complaint through the review portal. Please follow up promptly.</p>
     <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${tableRows}</table>
     ${detailsHtml}
     <p style="margin:24px 0 0"><a href="${escapeHtml(d.dashboardUrl)}" style="background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;display:inline-block;font-weight:600">Open complaint in dashboard</a></p>`,
  );
  return { subject, text, html };
}
