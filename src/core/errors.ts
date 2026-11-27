export class TintboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TintboxError';
    this.code = code;
  }
}

export class ValidationError extends TintboxError {
  constructor(message: string) {
    super('VALIDATION', message);
    this.name = 'ValidationError';
  }
}

export class LayerLockedError extends TintboxError {
  constructor(message = 'Layer locked') {
    super('LAYER_LOCKED', message);
    this.name = 'LayerLockedError';
  }
}

export class BoundsError extends TintboxError {
  constructor(message: string) {
    super('BOUNDS', message);
    this.name = 'BoundsError';
  }
}
