/* Setup wizard validation state shared between the core wizard and the
 * module setup steps: the ids of the steps whose "next" was blocked.
 * Required-field highlighting only shows up after a step has failed once. */
export const attemptedSteps = new Set<string>();
