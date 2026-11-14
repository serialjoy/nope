export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const isHttpError = (error) => error instanceof HttpError;
