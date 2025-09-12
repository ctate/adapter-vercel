/**
 * NOTE: THIS FILE CANNOT USE IMPORTS OUTSIDE OF THE FUNCTION
 * AS IT NEEDS TO BE STRINGIFIED entirely together
 */

export const getHandlerSource = (ctx: { projectRelativeDistDir: string }) =>
  `module.exports = (${(
    () => {
      const path = require('path') as typeof import('path');

      globalThis.AsyncLocalStorage = (
        require('async_hooks') as typeof import('async_hooks')
      ).AsyncLocalStorage;

      const relativeDistDir = process.env.__PRIVATE_RELATIVE_DIST_DIR as string;
      // - we need to process dynamic routes for matching
      // - we need to normalize _next/data, .rsc, segment prefetch to match
      // - we need this handler to be deterministic for all lambdas so it
      // can allow function de-duping
      // - we do not need to handle rewrites as matched-path comes after

      // we use the routes from the manifest as it is filtered to
      // only include the dynamic routes in that specific
      // function after de-duping at infra level
      const { dynamicRoutes: dynamicRoutesRaw, staticRoutes: staticRoutesRaw } =
        require(
          './' + path.posix.join(relativeDistDir, 'routes-manifest.json')
        ) as {
          dynamicRoutes: Array<{
            regex: string;
            page: string;
          }>;
          staticRoutes: Array<{
            regex: string;
            page: string;
          }>;
        };
      const hydrateRoutesManifestItem = (item: {
        regex: string;
        page: string;
      }) => {
        return {
          ...item,
          regex: new RegExp(item.regex),
        };
      };
      const dynamicRoutes = dynamicRoutesRaw.map(hydrateRoutesManifestItem);
      const staticRoutes = staticRoutesRaw.map(hydrateRoutesManifestItem);

      // maps un-normalized to normalized app path
      // e.g. /hello/(foo)/page -> /hello
      const appPathRoutesManifest = require(
        './' + path.posix.join(relativeDistDir, 'app-path-routes-manifest.json')
      ) as Record<string, string>;

      const inversedAppRoutesManifest = Object.entries(
        appPathRoutesManifest
      ).reduce(
        (manifest, [originalKey, normalizedKey]) => {
          manifest[normalizedKey] = originalKey;
          return manifest;
        },
        {} as Record<string, string>
      );

      function normalizeDataPath(pathname: string) {
        if (!(pathname || '/').startsWith('/_next/data')) {
          return pathname;
        }
        pathname = pathname
          .replace(/\/_next\/data\/[^/]{1,}/, '')
          .replace(/\.json$/, '');

        if (pathname === '/index') {
          return '/';
        }
        return pathname;
      }

      function matchUrlToPage(urlPathname: string) {
        // normalize first
        urlPathname = normalizeDataPath(urlPathname);

        console.log('before normalize', urlPathname);
        for (const suffixRegex of [
          /\.segments(\/.*)\.segment\.rsc$/,
          /\.prefetch\.rsc$/,
          /\.rsc$/,
        ]) {
          urlPathname = urlPathname.replace(suffixRegex, '');
        }
        console.log('after normalize', urlPathname);

        const getPathnameNoSlash = (urlPathname: string) =>
          urlPathname.replace(/\/$/, '') || '/';

        // check static routes
        for (const route of [...staticRoutes, ...dynamicRoutes]) {
          if (route.regex.test(urlPathname)) {
            console.log('matched route', route, urlPathname);
            return inversedAppRoutesManifest[route.page] || route.page;
          }
        }

        // we should have matched above but if not return back
        const pathnameNoSlash = getPathnameNoSlash(urlPathname);
        return inversedAppRoutesManifest[pathnameNoSlash] || pathnameNoSlash;
      }

      type Context = {
        waitUntil?: (promise: Promise<unknown>) => void;
        headers?: Record<string, string>;
      };

      const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');

      function getRequestContext(): Context {
        const fromSymbol: typeof globalThis & {
          [SYMBOL_FOR_REQ_CONTEXT]?: { get?: () => Context };
        } = globalThis;
        return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
      }

      return async function handler(
        req: import('http').IncomingMessage,
        res: import('http').ServerResponse
      ) {
        try {
          let urlPathname = req.headers['x-matched-path'];

          if (typeof urlPathname !== 'string') {
            const parsedUrl = new URL(req.url || '/', 'http://n');
            urlPathname = parsedUrl.pathname || '/';
          }
          const page = matchUrlToPage(urlPathname);
          const isAppDir = page.match(/\/(page|route)$/);

          const mod = require(
            './' +
              path.posix.join(
                relativeDistDir,
                'server',
                isAppDir ? 'app' : 'pages',
                `${page}.js`
              )
          );

          await mod.handler(req, res, {
            waitUntil: getRequestContext().waitUntil,
          });
        } catch (error) {
          console.error(`Failed to handle ${req.url}`, error);

          // If error bubbled to this point crash the function to
          // prevent attempting to re-use in bad state
          process.exit(1);
        }
      };
    }
  ).toString()})()`.replace(
    'process.env.__PRIVATE_RELATIVE_DIST_DIR',
    `"${ctx.projectRelativeDistDir}"`
  );
