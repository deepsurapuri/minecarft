/** Create an Error carrying an HTTP status and machine-readable code. */
export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
