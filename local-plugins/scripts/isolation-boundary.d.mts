export function resolveProjectLayout(projectRoot: string): { projectContainerRoot: string; originalProjectRoot: string };
export function createRunDirectory(localRoot: string, runName: string): string;
export function assertRunDirectory(localRoot: string, runName: string, runRoot: string): void;
export function ensureRunSubdirectory(runRoot: string, relative: string): string;
export function createChildEnvironment(baseEnv: Record<string, string>, runRoot: string, visible: boolean): Record<string, string>;
export function snapshotTree(root: string, options?: { contentOnly?: boolean }): string;
