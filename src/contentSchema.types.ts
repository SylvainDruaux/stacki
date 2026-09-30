// JSON Schema stays separate from field descriptors: wire metadata describes a
// schema, while descriptors record the controls and constraints the form uses.
export interface ContentSchema {
  readonly type?: string | readonly string[];
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, ContentSchema>>;
  readonly properties?: Readonly<Record<string, ContentSchema>>;
  readonly required?: readonly string[];
  readonly items?: ContentSchema;
  readonly additionalProperties?: ContentSchema | boolean;
  readonly anyOf?: readonly ContentSchema[];
  readonly oneOf?: readonly ContentSchema[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly description?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly astroImage?: boolean;
  readonly astroDate?: boolean;
  readonly astroReference?: string;
  readonly astroTransform?: boolean;
  readonly astroCoerced?: boolean;
  readonly recursive?: string;
  readonly recursiveOnly?: boolean;
}
export type Control =
  | 'unknown'
  | 'image'
  | 'reference'
  | 'date'
  | 'enum'
  | 'const'
  | 'boolean'
  | 'number'
  | 'references'
  | 'tags'
  | 'list'
  | 'record'
  | 'object'
  | 'union'
  | 'markdown'
  | 'code'
  | 'url'
  | 'email'
  | 'longtext'
  | 'text';
export interface Constraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly pattern?: string;
  readonly patternHint?: string | undefined;
  readonly minItems?: number;
  readonly maxItems?: number;
}
export interface FieldMember {
  readonly value: unknown;
  readonly label: string;
  readonly fields: readonly FieldDescriptor[];
}
export interface FieldDescriptor {
  readonly key: string | undefined;
  readonly label: string | undefined;
  readonly control: Control;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly description: string | undefined;
  readonly constraints: Constraints;
  readonly transform: boolean;
  readonly coerced: boolean;
  readonly default?: unknown;
  readonly options?: readonly unknown[];
  readonly const?: unknown;
  readonly target?: string;
  readonly recursive?: string;
  readonly fields?: readonly FieldDescriptor[];
  readonly value?: FieldDescriptor;
  readonly item?: FieldDescriptor;
  readonly discriminator?: string | undefined;
  readonly members?: readonly FieldMember[];
}
export interface FieldOptions {
  readonly required?: boolean;
  readonly root?: ContentSchema | undefined;
  readonly depth?: number;
  readonly visit?: () => void;
}
// Construction owns mutation; all exported descriptors remain read-only.
export type FieldBuilder = { -readonly [Key in keyof FieldDescriptor]: FieldDescriptor[Key] };
export type ConstraintBuilder = { -readonly [Key in keyof Constraints]: Constraints[Key] };
