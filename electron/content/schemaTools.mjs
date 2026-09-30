import { createRequire } from 'node:module';
import { z } from 'astro/zod';

const META = Symbol.for('stacki.astro.schema-meta');
export const definitionOf = (schema) => schema?._zod?.def || schema?._def || null;

// Astro 5 exposes Zod 3; newer versions expose Zod 4. Stubs create these
// schemas themselves, so attaching metadata to the older definition is local
// to introspection and never changes a schema inside the user's dev server.
export function withMetadata(schema, metadata) {
  if (typeof schema.meta === 'function') {
    return schema.meta(metadata);
  }
  schema._def[META] = { ...schema._def[META], ...metadata };
  return schema;
}

export function hasCrossFieldChecks(schema) {
  const def = definitionOf(schema);
  if (Array.isArray(def?.checks) && def.checks.length > 0) {
    return true;
  }
  if (def?.typeName === 'ZodEffects') {
    return def.effect?.type === 'refinement' || hasCrossFieldChecks(def.schema);
  }
  return false;
}

// Preserve file-side values: a transformed schema describes what the file
// stores, while date/image/reference annotations drive the editor's fields.
export function toJsonSchema(schema) {
  if (typeof z.toJSONSchema === 'function') {
    return z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
      cycles: 'ref',
      reused: 'inline',
      override({ zodSchema, jsonSchema }) {
        const def = definitionOf(zodSchema);
        if (def?.type === 'date') {
          jsonSchema.astroDate = true;
          if (def.coerce) {
            jsonSchema.astroCoerced = true;
          }
        }
        if (def?.type === 'pipe' || def?.type === 'transform') {
          jsonSchema.astroTransform = true;
        }
      },
    });
  }
  // Resolve through Astro's package, whose private dependencies may be in a
  // pnpm store rather than hoisted beside the project's staged runner.
  const projectRequire = createRequire(import.meta.url);
  const astroRequire = createRequire(projectRequire.resolve('astro/package.json'));
  const { zodToJsonSchema } = astroRequire('zod-to-json-schema');
  return zodToJsonSchema(schema, {
    effectStrategy: 'input',
    pipeStrategy: 'input',
    definitionPath: '$defs',
    postProcess(jsonSchema, def) {
      if (!jsonSchema) {
        return jsonSchema;
      }
      Object.assign(jsonSchema, def[META]);
      if (def.typeName === 'ZodDate') {
        jsonSchema.astroDate = true;
        if (def.coerce) {
          jsonSchema.astroCoerced = true;
        }
      }
      if (
        def.typeName === 'ZodPipeline' ||
        (def.typeName === 'ZodEffects' && def.effect?.type !== 'refinement')
      ) {
        jsonSchema.astroTransform = true;
      }
      return jsonSchema;
    },
  });
}
