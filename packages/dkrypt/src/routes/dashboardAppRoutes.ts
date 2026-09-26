import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardAppCatalogStatsRoute,
  DashboardAppMetadataRefreshRoute,
  DashboardAppMetadataRoute,
  DashboardAppSearchRoute,
} from '#dashboardAppCatalogContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { scopedLogger } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { lookupAppMetadata, searchApps, type ItunesAppMetadata, type ItunesSearchResult } from '#scheduler/itunes.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import {
  getAppCatalogEntries,
  getAppCatalogStats,
  upsertAppCatalogEntries,
  type AppCatalogEntry,
} from '#store/state.js';
import { decorateSearchResults, type TestFlightCatalogApp } from '#testflightSubscriptions.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

type SearchResult = ItunesSearchResult & {
  testflight?: Pick<TestFlightCatalogApp, 'appId' | 'devices' | 'lastVerifiedAt'>;
};

interface DashboardAppServices {
  searchApps: typeof searchApps;
  decorateSearchResults: (results: ItunesSearchResult[]) => Promise<SearchResult[]>;
  lookupAppMetadata: typeof lookupAppMetadata;
  getAppCatalogEntries: typeof getAppCatalogEntries;
  getAppCatalogStats: typeof getAppCatalogStats;
  upsertAppCatalogEntries: typeof upsertAppCatalogEntries;
}

const defaultServices: DashboardAppServices = {
  searchApps,
  decorateSearchResults,
  lookupAppMetadata,
  getAppCatalogEntries,
  getAppCatalogStats,
  upsertAppCatalogEntries,
};

const canViewScheduler = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
const canManageAppCatalog = fastifyRequirePermission(PermissionFlag.manageAutomation);
const bundleIdPattern = /^[A-Za-z0-9.-]{3,200}$/;
const log = scopedLogger('app-catalog');

function catalogEntryFromMetadata(metadata: ItunesAppMetadata): Omit<AppCatalogEntry, 'updatedAt'> {
  return {
    bundleId: metadata.bundleId,
    displayName: metadata.trackName,
    iconUrl: metadata.artworkUrl,
    trackId: metadata.trackId,
    sellerName: metadata.sellerName,
    category: metadata.category,
    description: metadata.description,
    screenshots: metadata.screenshots,
    releaseNotes: metadata.releaseNotes,
    price: metadata.price,
  };
}

async function fetchCatalogEntries(services: DashboardAppServices, bundleIds: string[]): Promise<AppCatalogEntry[]> {
  const fetched = await Promise.all(bundleIds.map(async (bundleId) => {
    try {
      return catalogEntryFromMetadata(await services.lookupAppMetadata(bundleId));
    } catch {
      return null;
    }
  }));
  return services.upsertAppCatalogEntries(fetched.filter((entry): entry is Omit<AppCatalogEntry, 'updatedAt'> => entry !== null));
}

export function createDashboardAppRoutes(overrides: Partial<DashboardAppServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardAppSearchRoute>('/v1/dashboard/search', {
      schema: getRouteContract('GET', '/v1/dashboard/search'),
    }, async (request, reply) => {
      const term = request.query.q.trim();
      if (!term) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'query param q is required');
      }

      try {
        const results = await services.decorateSearchResults(await services.searchApps(term));
        services.upsertAppCatalogEntries(results.map((result) => ({
          bundleId: result.bundleId,
          displayName: result.trackName,
          iconUrl: result.artworkUrl,
          trackId: result.trackId,
          sellerName: result.sellerName,
          category: result.category,
        })));
        return { results };
      } catch (error) {
        log.warn('dashboard app search failed', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
        reply.code(502);
        return {
          error: 'App Store search is temporarily unavailable',
          code: 'app_store_search_failed',
          message: 'App Store search is temporarily unavailable',
          requestId: request.id,
          retryable: true,
        };
      }
    });

    server.get<DashboardAppMetadataRoute>('/v1/dashboard/apps/metadata', {
      schema: getRouteContract('GET', '/v1/dashboard/apps/metadata'),
    }, async (request) => {
      const rawBundleIds = request.query.bundleIds ?? '';
      const bundleIds = [...new Set(rawBundleIds
        .split(',')
        .map((value) => value.trim())
        .filter((bundleId) => bundleIdPattern.test(bundleId)))].slice(0, 200);
      if (bundleIds.length === 0) return { entries: [] };

      const existing = new Map(services.getAppCatalogEntries(bundleIds).map((entry) => [entry.bundleId, entry]));
      const missing = bundleIds.filter((bundleId) => !existing.has(bundleId)).slice(0, 40);
      if (missing.length > 0) await fetchCatalogEntries(services, missing);

      return { entries: services.getAppCatalogEntries(bundleIds) };
    });

    server.get<DashboardAppCatalogStatsRoute>('/v1/dashboard/apps/cache', {
      schema: getRouteContract('GET', '/v1/dashboard/apps/cache'),
      preHandler: canViewScheduler,
    }, () => services.getAppCatalogStats());

    server.post<DashboardAppMetadataRefreshRoute>('/v1/dashboard/apps/metadata/refresh', {
      schema: getRouteContract('POST', '/v1/dashboard/apps/metadata/refresh'),
      preHandler: canManageAppCatalog,
    }, async (request, reply) => {
      const bundleIds = [...new Set(request.body.bundleIds.filter(
        (bundleId): bundleId is string => typeof bundleId === 'string' && bundleIdPattern.test(bundleId),
      ))].slice(0, 40);
      if (bundleIds.length === 0) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'at least one valid bundle ID is required');
      }
      return { entries: await fetchCatalogEntries(services, bundleIds) };
    });
  };
}

export const dashboardAppRoutes = createDashboardAppRoutes();
