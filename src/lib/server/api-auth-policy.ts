const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Politique transitoire des routes encore branchées sur `validateApiKey`.
 * Elle évite un big-bang sur les routes historiques tout en supprimant le scope
 * fourre-tout `legacy`. Une route inconnue échoue fermée.
 */
export function legacyMachineScopeForRequest(method: string, pathname: string): string | null {
	const write = WRITE_METHODS.has(method.toUpperCase());
	if (/^\/api\/blob(?:\/|$)/.test(pathname)) return write ? 'blob:write' : 'blob:read';
	if (/^\/api\/comments(?:\/|$)/.test(pathname)) return write ? 'comments:write' : 'comments:read';
	if (/^\/api\/content\/[^/]+\/status\/?$/.test(pathname)) return 'content:status';
	if (/^\/api\/content(?:\/|$)/.test(pathname)) return write ? 'content:write' : 'content:read';
	if (/^\/api\/projects\/[^/]+\/gsc(?:\/|$)/.test(pathname)) return write ? 'gsc:write' : 'gsc:read';
	if (/^\/api\/projects\/[^/]+\/(?:gmb-|reviews|employee-mentions)(?:\/|$)/.test(pathname)) return write ? 'gmb:write' : 'gmb:read';
	if (/^\/api\/projects\/[^/]+\/indexing(?:\/|$)/.test(pathname)) return write ? 'indexing:write' : 'indexing:read';
	if (/^\/api\/projects\/[^/]+\/keywords(?:\/|$)/.test(pathname)) return write ? 'keywords:write' : 'keywords:read';
	if (/^\/api\/projects(?:\/|$)/.test(pathname)) return write ? 'projects:write' : 'projects:read';
	if (/^\/api\/reviews(?:\/|$)/.test(pathname)) return write ? 'reviews:write' : 'reviews:read';
	if (/^\/api\/seo-reports(?:\/|$)/.test(pathname)) return write ? 'seo-reports:write' : 'seo-reports:read';
	if (pathname === '/api/whoami' || pathname === '/api/whoami/') return 'system:read';
	return null;
}