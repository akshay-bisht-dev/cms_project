// Plain module: labels and badge tones shared by server and client components.

export const CLIENT_STATUS = { PROSPECT: ['Prospect', 'info'], ACTIVE: ['Active', 'success'], INACTIVE: ['Inactive', 'neutral'] };
export const LEAD_STATUS = {
  NEW: ['New', 'info'],
  CONTACTED: ['Contacted', 'info'],
  QUALIFIED: ['Qualified', 'success'],
  UNQUALIFIED: ['Unqualified', 'neutral'],
  CONVERTED: ['Converted', 'success'],
  LOST: ['Lost', 'danger'],
};
export const LEAD_NEXT = {
  NEW: ['CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'LOST'],
  CONTACTED: ['QUALIFIED', 'UNQUALIFIED', 'LOST', 'NEW'],
  QUALIFIED: ['CONTACTED', 'UNQUALIFIED', 'LOST'],
  UNQUALIFIED: ['NEW', 'CONTACTED', 'LOST'],
  LOST: ['NEW', 'CONTACTED'],
  CONVERTED: [],
};
export const QUOTE_STATUS = {
  DRAFT: ['Draft', 'neutral'],
  SENT: ['Sent', 'info'],
  ACCEPTED: ['Accepted', 'success'],
  DECLINED: ['Declined', 'danger'],
  EXPIRED: ['Expired', 'warning'],
  SUPERSEDED: ['Superseded', 'neutral'],
};
export const TICKET_STATUS = {
  OPEN: ['Open', 'info'],
  IN_PROGRESS: ['In progress', 'info'],
  WAITING_CLIENT: ['Waiting for client', 'warning'],
  RESOLVED: ['Resolved', 'success'],
  CLOSED: ['Closed', 'neutral'],
};
export const PRIORITY = { LOW: ['Low', 'neutral'], NORMAL: ['Normal', 'info'], HIGH: ['High', 'warning'], URGENT: ['Urgent', 'danger'] };
export const INVOICE_STATUS = {
  DRAFT: ['Draft', 'neutral'],
  ISSUED: ['Issued', 'info'],
  PARTIALLY_PAID: ['Partly paid', 'warning'],
  PAID: ['Paid', 'success'],
  VOID: ['Void', 'neutral'],
};
export const EXPENSE_STATUS = {
  DRAFT: ['Draft', 'neutral'],
  SUBMITTED: ['Submitted', 'info'],
  APPROVED: ['Approved', 'success'],
  REJECTED: ['Rejected', 'danger'],
  REIMBURSED: ['Reimbursed', 'success'],
};
export const COMM_KIND = { NOTE: 'Note', CALL: 'Call', EMAIL: 'Email', MEETING: 'Meeting' };
