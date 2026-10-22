/** Sends the standard success envelope: `{ success: true, data, meta }`. */
export function sendOk(res, data, { status = 200, meta = {} } = {}) {
  return res.status(status).json({ success: true, data, meta });
}

export function sendCreated(res, data, meta) {
  return sendOk(res, data, { status: 201, meta });
}

export function sendNoContent(res) {
  return res.status(204).end();
}
