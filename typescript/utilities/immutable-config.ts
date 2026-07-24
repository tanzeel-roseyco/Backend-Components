/**
 * Immutable Configuration Container
 * Single source of truth for all application configuration.
 * Prevents runtime mutations and provides type-safe access.
 */

export interface ConfigSchema {
  [key: string]: ConfigSchemaValue;
}

export type ConfigSchemaValue =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | ConfigSchema;

export interface ConfigOptions {
  schema: ConfigSchema;
  defaults?: Record<string, any>;
  envPrefix?: string;
  throwOnMissing?: boolean;
}

export class ImmutableConfig {
  private data: Record<string, any>;
  private schema: ConfigSchema;

  private constructor(data: Record<string, any>, schema: ConfigSchema) {
    this.data = Object.freeze(JSON.parse(JSON.stringify(data)));
    this.schema = schema;
  }

  static create(options: ConfigOptions): ImmutableConfig {
    const data: Record<string, any> = {
      ...options.defaults,
    };

    // Load from environment variables
    const prefix = options.envPrefix || '';
    for (const [key, schemaType] of Object.entries(options.schema)) {
      const envKey = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();
      const envValue = process.env[envKey];

      if (envValue !== undefined) {
        data[key] = coerceValue(envValue, schemaType);
      } else if (!data.hasOwnProperty(key) && options.throwOnMissing) {
        throw new Error(`Missing required config: ${envKey}`);
      }
    }

    return new ImmutableConfig(data, options.schema);
  }

  get<T = any>(path: string, defaultValue?: T): T {
    const value = this.getNestedValue(path);
    return value !== undefined ? value : defaultValue;
  }

  getOrThrow<T = any>(path: string): T {
    const value = this.getNestedValue(path);
    if (value === undefined) {
      throw new Error(`Missing required config: ${path}`);
    }
    return value as T;
  }

  private getNestedValue(path: string): any {
    const keys = path.split('.');
    let value = this.data;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }

  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [key, schemaType] of Object.entries(this.schema)) {
      if (!this.data.hasOwnProperty(key)) {
        errors.push(`Missing required key: ${key}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  toJSON(): Record<string, any> {
    return JSON.parse(JSON.stringify(this.data));
  }
}

function coerceValue(value: string, schemaType: ConfigSchemaValue): any {
  if (typeof schemaType === 'string') {
    switch (schemaType) {
      case 'string':
        return value;
      case 'number':
        const num = Number(value);
        if (isNaN(num)) throw new Error(`Cannot coerce "${value}" to number`);
        return num;
      case 'boolean':
        return value.toLowerCase() === 'true' || value === '1';
      case 'string[]':
        return value.split(',').map((s) => s.trim());
      case 'number[]':
        return value.split(',').map((s) => {
          const num = Number(s.trim());
          if (isNaN(num)) throw new Error(`Cannot coerce "${s}" to number`);
          return num;
        });
      default:
        return value;
    }
  }

  return value;
}
