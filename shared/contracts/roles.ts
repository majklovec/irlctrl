/** A role id is owned by a module and validated against registered role definitions. */
export type Role = string;

/** Presentation and setup metadata contributed by the module that provides a role. */
export interface RoleDefinition {
    id: Role;
    titleKey: string;
    taglineKey?: string;
    order: number;
    default?: boolean;
    setupSelectable?: boolean;
}
