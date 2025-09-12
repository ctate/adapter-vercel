import type { NextAdapter, NextConfig } from 'next';
import { convertRewrites } from '@vercel/routing-utils/dist/superstatic';
import type {
  HasField,
  Rewrite,
  Route,
  RouteWithSrc,
} from '@vercel/routing-utils';

type AdapterRoutes = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]['routes'];

export function normalizeRedirect(item: AdapterRoutes['redirects'][0]) {
  return {
    source: item.source,
    destination: item.destination,
    statusCode: item.statusCode,
    permanent: item.permanent,
    has: item.has as HasField,
    missing: item.missing as HasField,
  };
}

export function normalizeRewrites(rewrites: AdapterRoutes['rewrites']) {
  const normalize = (item: (typeof rewrites)['beforeFiles'][0]): Rewrite => ({
    source: item.source,
    destination: item.destination,
    has: item.has as HasField,
    missing: item.missing as HasField,
  });

  const internalParams = ['nextInternalLocale'];

  return {
    beforeFiles: convertRewrites(
      rewrites.beforeFiles.map(normalize),
      internalParams
    ).map((item) => {
      if ('check' in item) {
        delete item.check;
        item.continue = true;
        item.override = true;
      }
      return item;
    }),
    afterFiles: convertRewrites(
      rewrites.afterFiles.map(normalize),
      internalParams
    ),
    fallback: convertRewrites(rewrites.fallback.map(normalize), internalParams),
  };
}

export function modifyWithRewriteHeaders(
  rewrites: Route[],
  {
    isAfterFilesRewrite = false,
    shouldHandlePrefetchRsc,
    shouldHandleSegmentPrefetches,
  }: {
    isAfterFilesRewrite?: boolean;
    shouldHandlePrefetchRsc?: boolean;
    shouldHandleSegmentPrefetches?: boolean;
  }
) {
  for (let i = 0; i < rewrites.length; i++) {
    const rewrite = rewrites[i];

    // If this doesn't have a src or dest, we can't modify it.
    if (!rewrite.src || !rewrite.dest) continue;

    // We're not using the url.parse here because the destination is not
    // guaranteed to be a valid URL, it's a pattern, where the domain may
    // include patterns like `https://:subdomain.example.com` that would not
    // be parsed correctly.

    let protocol: string | null = null;
    if (rewrite.dest.startsWith('http://')) {
      protocol = 'http://';
    } else if (rewrite.dest.startsWith('https://')) {
      protocol = 'https://';
    }

    // We only support adding rewrite headers to routes that do not have
    // a protocol, so don't bother trying to parse the pathname if there is
    // a protocol.
    let pathname: string | null = null;
    let query: string | null = null;
    if (!protocol) {
      // Start with the full destination as the pathname. If there's a query
      // then we'll remove it.
      pathname = rewrite.dest;

      let index = pathname.indexOf('?');
      if (index !== -1) {
        query = pathname.substring(index + 1);
        pathname = pathname.substring(0, index);

        // If there's a hash, we should remove it.
        index = query.indexOf('#');
        if (index !== -1) {
          query = query.substring(0, index);
        }
      } else {
        // If there's a hash, we should remove it.
        index = pathname.indexOf('#');
        if (index !== -1) {
          pathname = pathname.substring(0, index);
        }
      }
    }

    if (isAfterFilesRewrite) {
      // ensures that userland rewrites are still correctly matched to their special outputs
      // PPR should match .prefetch.rsc, .rsc
      // non-PPR should match .rsc
      const parts = ['\\.rsc'];
      if (shouldHandlePrefetchRsc) {
        parts.push('\\.prefetch\\.rsc');
      }
      if (shouldHandleSegmentPrefetches) {
        parts.push('\\.segments/.+\\.segment\\.rsc');
      }

      const rscSuffix = parts.join('|');

      rewrite.src = rewrite.src.replace(
        /\/?\(\?:\/\)\?/,
        `(?:/)?(?<rscsuff>${rscSuffix})?`
      );

      const destQueryIndex = rewrite.dest.indexOf('?');
      if (destQueryIndex === -1) {
        rewrite.dest = `${rewrite.dest}$rscsuff`;
      } else {
        rewrite.dest = `${rewrite.dest.substring(
          0,
          destQueryIndex
        )}$rscsuff${rewrite.dest.substring(destQueryIndex)}`;
      }
    }

    // If the rewrite was external or didn't include a pathname or query,
    // we don't need to add the rewrite headers.
    if (protocol || (!pathname && !query)) continue;

    (rewrite as RouteWithSrc).headers = {
      ...(rewrite as RouteWithSrc).headers,

      ...(pathname
        ? {
            ['x-nextjs-rewritten-path']: pathname,
          }
        : {}),

      ...(query
        ? {
            ['x-nextjs-rewritten-query']: query,
          }
        : {}),
    };
  }
}

export function normalizeDynamicRoutes(
  dynamicRoutes: AdapterRoutes['dynamicRoutes']
) {
  return dynamicRoutes.map(
    (item) =>
      ({
        src: item.namedRegex || item.regex,
        dest: `${item.page}?${Object.entries(item.routeKeys || {})
          .map(([namedKey, originalKey]) => {
            return `${originalKey}=$${namedKey}`;
          })
          .join('&')}`,
        check: true,
      }) satisfies RouteWithSrc
  );
}
