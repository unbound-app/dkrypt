export function createHttpErrorEnvelope(requestId: string, statusCode: number, message: string) {
  const publicMessage = statusCode >= 500 ? 'internal server error' : message;
  return {
    error: publicMessage,
    code: statusCode >= 500 ? 'internal_error' : 'request_error',
    message: publicMessage,
    requestId,
    retryable: statusCode >= 500,
  };
}
