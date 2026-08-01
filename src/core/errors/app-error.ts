export interface AppErrorOptions {
  readonly code: string;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
  }
}

export class RetryableError extends AppError {}

export class PermanentError extends AppError {}

export class SourceIdentityConflictError extends PermanentError {
  constructor(sourceId: string, externalId: string, options?: { readonly cause?: unknown }) {
    super(
      `External product identity already exists for source ${sourceId}: ${externalId}`,
      { code: "SOURCE_IDENTITY_CONFLICT", ...options },
    );
  }
}

export class MappingMissingError extends PermanentError {
  constructor(mappingKey: string) {
    super(`Mapping is missing: ${mappingKey}`, {
      code: "MAPPING_MISSING",
    });
  }
}

export class AdapterNotRegisteredError extends PermanentError {
  constructor(key: string) {
    super(`Source adapter is not registered: ${key}`, {
      code: "ADAPTER_NOT_REGISTERED",
    });
  }
}

export class ProcessorNotRegisteredError extends PermanentError {
  constructor(key: string) {
    super(`Source processor is not registered: ${key}`, {
      code: "PROCESSOR_NOT_REGISTERED",
    });
  }
}

export class ExporterNotRegisteredError extends PermanentError {
  constructor(key: string) {
    super(`Target exporter is not registered: ${key}`, {
      code: "EXPORTER_NOT_REGISTERED",
    });
  }
}

export class DuplicateRegistrationError extends PermanentError {
  constructor(componentType: string, code: string) {
    super(`${componentType} is already registered: ${code}`, {
      code: "DUPLICATE_REGISTRATION",
    });
  }
}
