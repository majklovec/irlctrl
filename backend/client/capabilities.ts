/**
 * Capability bus — the seam between modules for runtime services.
 *
 * A module exposes services under capability names in its registration's
 * `services.capabilities` record (see modules/README.md); the device lifecycle
 * wires those records into this bus at load, and other modules reach them
 * through `core.requireCapability("<name>")` — never by module id. The shapes
 * behind a name are agreed between the providing and consuming modules; the
 * core stores and forwards them without knowing them.
 */
const provided = new Map<string, unknown>();

/** Register a capability implementation. Re-registering replaces the old one. */
export function provideCapability<T>(name: string, impl: T): T {
    provided.set(name, impl);
    return impl;
}

/** Look up a capability by name. Throws when no module provides it. */
export function requireCapability<T = unknown>(name: string): T {
    const impl = provided.get(name);
    if (impl === undefined)
        throw new Error(
            `capability ${JSON.stringify(name)} is not provided by any module`,
        );
    return impl as T;
}

/** Whether a capability is currently provided. */
export const hasCapability = (name: string): boolean => provided.has(name);

/** Drop all capabilities (registry reload, tests). */
export function clearCapabilities(): void {
    provided.clear();
}
