export function errRes(res, status, code, message, fields = undefined) {
  const body = { success: false, error: { code, message } };
  if (fields) body.error.fields = fields;
  return res.status(status).json(body);
}
