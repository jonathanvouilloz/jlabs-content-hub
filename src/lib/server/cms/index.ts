import type { CmsAdapter } from './types.js';
import { WebflowAdapter } from './webflow.js';

export function getAdapter(cmsType: string): CmsAdapter {
	switch (cmsType) {
		case 'webflow':
			return new WebflowAdapter();
		default:
			throw new Error(`CMS type "${cmsType}" is not supported`);
	}
}

export type { CmsAdapter, CmsConnectionConfig, CmsItemData, CmsPublishResult } from './types.js';
