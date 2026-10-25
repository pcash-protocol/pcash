export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@pcash/")) {
    throw new Error(`launcher resolved workspace package ${specifier}`);
  }
  return next(specifier, context);
}
