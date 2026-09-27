export class SuiteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** Thrown whenever one identity would touch a resource owned by another identity. */
export class IsolationError extends SuiteError {
  constructor(message: string) {
    super(message, 403);
  }
}

export class NotFoundError extends SuiteError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ValidationError extends SuiteError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ConflictError extends SuiteError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class NotSupportedError extends SuiteError {
  constructor(message: string) {
    super(message, 501);
  }
}
