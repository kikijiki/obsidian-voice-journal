import { isAbsolute, relative, sep } from 'node:path';

/**
 * Whether `candidate` is strictly inside `parent` (a proper descendant, never
 * equal to it). Built on `path.relative` rather than a `startsWith` prefix
 * check, which breaks when `parent` is the filesystem root (`/`): appending
 * the separator there produces `//`, which no real child path starts with,
 * silently treating every file as outside. Both `parent` and `candidate`
 * must already be resolved/normalized absolute paths. The separator-suffixed
 * `..${sep}` check (rather than a bare `..`) matters too: a real file or
 * directory can be literally named `..foo`, and `relative()` would return
 * that unprefixed, which must not be mistaken for an escaping `../foo`.
 */
export function isPathInside(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return (
		path !== '' &&
		path !== '..' &&
		!path.startsWith(`..${sep}`) &&
		!isAbsolute(path)
	);
}

/** Same as {@link isPathInside}, but also true when `candidate` equals `parent`. */
export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
	return candidate === parent || isPathInside(parent, candidate);
}
