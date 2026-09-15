// `server-only` is a guard for the bundler: importing it from a Client Component is meant to fail
// the build. Under Vitest there are no component boundaries to enforce, and the real package throws
// on import, so a server module could not be unit-tested at all. This stands in for it.
export {};
