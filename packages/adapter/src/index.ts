import fs from 'fs/promises';
import path from 'node:path';
import type { NextAdapter } from 'next';
import type { VercelConfig } from './types';
import { MAX_AGE_ONE_YEAR } from './constants';
import type { HasField } from '@vercel/routing-utils';
import { getImagesConfig } from './utils';
import {
  modifyWithRewriteHeaders,
  normalizeDynamicRoutes,
  normalizeRedirect,
  normalizeRewrites,
} from './routing';

import {
  type FuncOutputs,
  handleEdgeOutputs,
  handleNodeOutputs,
  handlePrerenderOutputs,
  handleStaticOutputs,
} from './outputs';

import {
  convertHeaders,
  convertRedirects,
} from '@vercel/routing-utils/dist/superstatic';

const myAdapter: NextAdapter = {
  name: 'Vercel',
  async onBuildComplete({
    routes,
    config,
    outputs,
    distDir,
    repoRoot,
    projectDir,
    nextVersion,
  }) {
    const vercelOutputDir = path.join(distDir, 'output');
    await fs.mkdir(vercelOutputDir, { recursive: true });

    const i18nConfig = config.i18n;
    const vercelConfig: VercelConfig = {
      version: 3,
      overrides: {},
      wildcard: i18nConfig?.domains
        ? i18nConfig.domains.map((item) => {
            return {
              domain: item.domain,
              value:
                item.defaultLocale === i18nConfig.defaultLocale
                  ? ''
                  : `/${item.defaultLocale}`,
            };
          })
        : undefined,
      images: getImagesConfig(config),
    };

    await handleStaticOutputs(outputs.staticFiles, {
      config,
      vercelConfig,
      vercelOutputDir,
    });

    let nodeOutputs: FuncOutputs = [];
    const edgeOutputs: FuncOutputs = [];

    for (const output of [
      ...outputs.appPages,
      ...outputs.appRoutes,
      ...outputs.pages,
      ...outputs.pagesApi,
    ]) {
      if (output.runtime === 'nodejs') {
        nodeOutputs.push(output);
      } else if (output.runtime === 'edge') {
        edgeOutputs.push(output);
      }
    }

    // handle edge functions
    await handleEdgeOutputs(edgeOutputs, {
      config,
      distDir,
      repoRoot,
      projectDir,
      vercelOutputDir,
    });

    // handle prerenders
    nodeOutputs = await handlePrerenderOutputs(
      nodeOutputs,
      outputs.prerenders,
      {
        config,
        distDir,
        repoRoot,
        projectDir,
        nextVersion,
        vercelOutputDir,
      }
    );

    // handle node functions
    await handleNodeOutputs(nodeOutputs, {
      config,
      distDir,
      repoRoot,
      projectDir,
      nextVersion,
      vercelOutputDir,
    });

    // TODO: should these be signaled to onBuildComplete directly
    // somehow or should they be derived from outputs?
    const shouldHandlePrefetchRsc = Boolean(config.experimental.ppr);
    const shouldHandleSegmentPrefetches = Boolean(
      config.experimental.clientSegmentCache
    );

    // create routes
    const convertedRewrites = normalizeRewrites(routes.rewrites);

    if (shouldHandlePrefetchRsc || shouldHandleSegmentPrefetches) {
      modifyWithRewriteHeaders(convertedRewrites.beforeFiles, {
        shouldHandlePrefetchRsc,
        shouldHandleSegmentPrefetches,
      });

      modifyWithRewriteHeaders(convertedRewrites.afterFiles, {
        isAfterFilesRewrite: true,
        shouldHandlePrefetchRsc,
        shouldHandleSegmentPrefetches,
      });

      modifyWithRewriteHeaders(convertedRewrites.fallback, {
        shouldHandlePrefetchRsc,
        shouldHandleSegmentPrefetches,
      });
    }

    const convertedHeaders = convertHeaders(
      routes.headers.map((item) => ({
        source: item.source,
        headers: item.headers,
        has: item.has as HasField,
        missing: item.missing as HasField,
      }))
    );

    const priorityRedirects: ReturnType<typeof normalizeRedirect>[] = [];
    const redirects: ReturnType<typeof normalizeRedirect>[] = [];

    for (const redirect of routes.redirects) {
      const normalized = normalizeRedirect(redirect);

      if (redirect.priority) {
        priorityRedirects.push(normalized);
      } else {
        redirects.push(normalized);
      }
    }

    const convertedPriorityRedirects = convertRedirects(priorityRedirects);
    const convertedRedirects = convertRedirects(redirects);
    const convertedDynamicRoutes = normalizeDynamicRoutes(routes.dynamicRoutes);

    vercelConfig.routes = [
      /*
        Desired routes order
        - Runtime headers
        - User headers and redirects
        - Runtime redirects
        - Runtime routes
        - Check filesystem, if nothing found continue
        - User rewrites
        - Builder rewrites
      */
      ...convertedPriorityRedirects,

      // normalize _next/data if middleware + pages

      // i18n prefixing routes

      ...convertedHeaders,

      ...convertedRedirects,

      // server actions name meta routes

      // if skip middleware url normalize we denormalize _next/data if middleware + pages

      // middleware route

      // if skip middleware url normalize we normalize _next/data if middleware + pages

      ...convertedRewrites.beforeFiles,

      // add 404 handling if /404 or locale variants are requested literally

      // add 500 handling if /500 or locale variants are requested literally

      // denormalize _next/data if middleware + pages

      // segment prefetch request rewriting

      // non-segment prefetch rsc request rewriting

      // full rsc request rewriting

      { handle: 'filesystem' },

      // ensure the basePath prefixed _next/image is rewritten to the root
      // _next/image path
      ...(config.basePath
        ? [
            {
              src: path.posix.join('/', config.basePath, '_next/image/?'),
              dest: '/_next/image',
              check: true,
            },
          ]
        : []),

      // normalize _next/data if middleware + pages

      // normalize /index.rsc to just /

      ...convertedRewrites.afterFiles,

      // ensure bad rewrites with /.rsc are fixed

      { handle: 'resource' },

      ...convertedRewrites.fallback,

      // make sure 404 page is used when a directory is matched without
      // an index page
      { src: path.posix.join('/', config.basePath, '.*'), status: 404 },

      { handle: 'miss' },

      // 404 to plain text file for _next/static

      // if i18n is enabled attempt removing locale prefix to check public files

      // rewrite segment prefetch to prefetch/rsc

      { handle: 'rewrite' },

      // denormalize _next/data if middleware + pages

      // apply _next/data routes (including static ones if middleware + pages)

      // apply 404 if _next/data request since above should have matched
      // and we don't want to match a catch-all dynamic route

      // apply normal dynamic routes
      ...convertedDynamicRoutes,

      // apply x-nextjs-matched-path header and __next_data_catchall rewrite
      // if middleware + pages

      { handle: 'hit' },

      // Before we handle static files we need to set proper caching headers
      {
        // This ensures we only match known emitted-by-Next.js files and not
        // user-emitted files which may be missing a hash in their filename.
        src: path.posix.join(
          '/',
          config.basePath,
          `_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media)/.+`
        ),
        // Next.js assets contain a hash or entropy in their filenames, so they
        // are guaranteed to be unique and cacheable indefinitely.
        headers: {
          'cache-control': `public,max-age=${MAX_AGE_ONE_YEAR},immutable`,
        },
        continue: true,
        important: true,
      },
      {
        src: path.posix.join('/', config.basePath, '/index(?:/)?'),
        headers: {
          'x-matched-path': '/',
        },
        continue: true,
        important: true,
      },
      {
        src: path.posix.join('/', config.basePath, `/((?!index$).*?)(?:/)?`),
        headers: {
          'x-matched-path': '/$1',
        },
        continue: true,
        important: true,
      },

      { handle: 'error' },

      // apply 404 output mapping

      // apply 500 output mapping
    ];

    const outputConfigPath = path.join(vercelOutputDir, 'config.json');
    await fs.writeFile(outputConfigPath, JSON.stringify(vercelConfig, null, 2));
  },
};

export = myAdapter;
