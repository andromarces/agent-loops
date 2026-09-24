// Husky is a devDependency, so a registry or consumer install without it must
// still succeed when npm runs the `prepare` script. Skip in CI and production,
// and treat a missing Husky as a successful no-op.
if (process.env.CI === "true" || process.env.NODE_ENV === "production") process.exit(0);

let husky;
try {
  husky = (await import("husky")).default;
} catch (error) {
  if (error.code === "ERR_MODULE_NOT_FOUND") process.exit(0);
  throw error;
}

console.log(husky());
