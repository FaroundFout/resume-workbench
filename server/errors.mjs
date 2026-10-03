/** Public errors contain controlled messages, never filesystem paths. */
export class AppError extends Error {
  constructor(code, message, status = 400, fields) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (fields !== undefined) this.fields = fields;
  }
}
