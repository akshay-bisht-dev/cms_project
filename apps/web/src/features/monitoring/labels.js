// Plain module (no 'use client'): shared by server pages and client components.

/** Why the desktop app is not capturing right now. */
export const PAUSE_REASON_LABEL = {
  NOT_CONFIGURED: 'Monitoring has not been set up for your organization',
  MONITORING_OFF: 'Monitoring is turned off for your organization',
  POLICY_DISABLED: 'Your policy does not take screenshots',
  CONSENT_REQUIRED: 'Waiting for you to acknowledge the monitoring notice',
  CONSENT_WITHDRAWN: 'You withdrew your acknowledgement',
  CLOCKED_OUT: 'You are clocked out',
  ON_BREAK: 'You are on a break',
};

/** Why an expected capture is missing; shown in the gallery so gaps are never misread. */
export const FAILURE_LABEL = {
  DROPPED_QUEUE_FULL: 'Dropped: the device queue was full',
  EXPIRED: 'Expired before it could be uploaded',
  CAPTURE_FAILED: 'The device could not capture the screen',
  UPLOAD_FAILED: 'Upload failed',
  PERMISSION_DENIED: 'Screen-recording permission was missing',
  UPLOAD_TIMEOUT: 'The upload never finished',
  UPLOAD_MISMATCH: 'Rejected: the upload did not match',
  INVALID_IMAGE: 'Rejected: not a valid image',
  CHECKSUM_MISMATCH: 'Rejected: the file changed in transit',
  OBJECT_MISSING: 'The uploaded file was missing',
};

export const SCOPE_LABEL = {
  self: 'only their own',
  team: 'people in teams they lead',
  department: 'people in departments they manage',
  project: 'people on projects they manage',
  org: 'everyone in the organization',
};

export const CONSENT_LABEL = {
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'success' },
  REQUIRED: { label: 'Acknowledgement needed', tone: 'warning' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'danger' },
};

export const AGENT_STATE_LABEL = {
  CAPTURING: 'Capturing',
  PAUSED: 'Paused',
  PERMISSION_MISSING: 'Needs screen-recording permission',
  ERROR: 'Error',
  STARTING: 'Starting',
};

/** A device that has not checked in for this long is shown as offline. */
export const AGENT_OFFLINE_AFTER_MS = 3 * 60_000;

export function describeInterval(seconds) {
  if (!seconds) return '—';
  return seconds % 60 === 0 ? `every ${seconds / 60} min` : `every ${seconds} s`;
}
