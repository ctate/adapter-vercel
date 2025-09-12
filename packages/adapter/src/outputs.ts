import path from 'node:path';
import fs from 'node:fs/promises';
import { Sema } from 'async-sema';
import type { AdapterOutput, NextConfig } from 'next';
import type { VercelConfig } from './types';
import { getHandlerSource } from './node-handler';
import { getNodeVersion } from '@vercel/build-utils';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { getNextjsEdgeFunctionSource } from './get-edge-function-source';

export async function handleStaticOutputs(
  outputs: Array<AdapterOutput['STATIC_FILE']>,
  {
    config,
    vercelConfig,
    vercelOutputDir,
  }: {
    config: NextConfig;
    vercelConfig: VercelConfig;
    vercelOutputDir: string;
  }
) {
  const fsSema = new Sema(16, { capacity: outputs.length });

  await Promise.all(
    outputs.map(async (output) => {
      await fsSema.acquire();

      const srcExtension = path.extname(output.filePath);
      const destExtension = path.extname(output.pathname);

      // automatically statically optimized pages should
      // be output to static folder but apply content-type override
      if (srcExtension === '.html' && !destExtension) {
        vercelConfig.overrides[path.posix.join('./', output.pathname)] = {
          contentType: 'text/html; charset=utf-8',
        };
      }
      const destination = path.join(
        vercelOutputDir,
        'static',
        config.basePath || '',
        output.pathname
      );
      const destDirectory = path.dirname(destination);

      await fs.mkdir(destDirectory, { recursive: true });
      await fs.rename(output.filePath, destination);

      fsSema.release();
    })
  );
}

export type FuncOutputs = Array<
  | AdapterOutput['PAGES']
  | AdapterOutput['APP_PAGE']
  | AdapterOutput['APP_ROUTE']
  | AdapterOutput['PAGES_API']
>;

export async function handleNodeOutputs(
  nodeOutputs: FuncOutputs,
  {
    config,
    distDir,
    repoRoot,
    projectDir,
    nextVersion,
    vercelOutputDir,
  }: {
    config: NextConfig;
    distDir: string;
    repoRoot: string;
    projectDir: string;
    nextVersion: string;
    vercelOutputDir: string;
  }
) {
  const nodeVersion = await getNodeVersion(projectDir, undefined, {}, {});

  const fsSema = new Sema(16, { capacity: nodeOutputs.length });
  const functionsDir = path.join(vercelOutputDir, 'functions');
  const handlerRelativeDir = path.posix.relative(repoRoot, projectDir);

  await Promise.all(
    nodeOutputs.map(async (output) => {
      await fsSema.acquire();

      const functionDir = path.join(
        functionsDir,
        config.basePath || '',
        `${output.pathname}.func`
      );
      await fs.mkdir(functionDir, { recursive: true });

      const files: Record<string, string> = {};

      for (const [relPath, fsPath] of Object.entries(output.assets)) {
        files[relPath] = path.posix.relative(repoRoot, fsPath);
      }
      files[path.posix.relative(projectDir, output.filePath)] =
        path.posix.relative(repoRoot, output.filePath);

      const handlerFilePath = path.join(
        functionDir,
        handlerRelativeDir,
        '___next_launcher.cjs'
      );
      await fs.mkdir(path.dirname(handlerFilePath), { recursive: true });
      await fs.writeFile(
        handlerFilePath,
        getHandlerSource({
          projectRelativeDistDir: path.posix.relative(projectDir, distDir),
        })
      );

      const operationType =
        output.type === AdapterOutputType.APP_PAGE || AdapterOutputType.PAGES
          ? 'PAGE'
          : 'API';

      // TODO: read vercel.json for additional function options

      await fs.writeFile(
        path.join(functionDir, `.vc-config.json`),
        JSON.stringify(
          // TODO: strongly type this
          {
            filePathMap: files,
            operationType,
            framework: {
              slug: 'nextjs',
              version: nextVersion,
            },
            handler: path.posix.join(
              path.posix.relative(repoRoot, projectDir),
              '___next_launcher.cjs'
            ),
            runtime: nodeVersion.runtime,
            maxDuration: output.config.maxDuration,
            supportsResponseStreaming: true,
            experimentalAllowBundling: true,
          },
          null,
          2
        )
      );

      fsSema.release();
    })
  );
}

export async function handlePrerenderOutputs(
  nodeOutputs: FuncOutputs,
  prerenderOutputs: Array<AdapterOutput['PRERENDER']>,
  {
    config,
    distDir,
    repoRoot,
    projectDir,
    nextVersion,
    vercelOutputDir,
  }: {
    config: NextConfig;
    distDir: string;
    repoRoot: string;
    projectDir: string;
    nextVersion: string;
    vercelOutputDir: string;
  }
): Promise<FuncOutputs> {
  const nodeOutputsParentMap = new Map<string, FuncOutputs[0]>();
  const prerenderParentIds = new Set<string>();

  for (const output of nodeOutputs) {
    nodeOutputsParentMap.set(output.id, output);
  }
  const fsSema = new Sema(16, { capacity: prerenderOutputs.length });
  const functionsDir = path.join(vercelOutputDir, 'functions');

  await Promise.all(
    prerenderOutputs.map(async (output) => {
      await fsSema.acquire();

      try {
        const prerenderConfigPath = path.join(
          functionsDir,
          `${output.pathname}.prerender-config.json`
        );
        const prerenderFallbackPath = output.fallback?.filePath
          ? path.join(
              functionsDir,
              `${output.pathname}.prerender-fallback${path.extname(output.fallback.filePath)}`
            )
          : undefined;

        const { parentOutputId } = output;
        prerenderParentIds.add(parentOutputId);

        const parentNodeOutput = nodeOutputsParentMap.get(parentOutputId);

        if (!parentNodeOutput) {
          throw new Error(
            `Invariant: failed to find parent node output ${output.parentOutputId} for prerender output ${output.pathname}`
          );
        }

        const clonedNodeOutput = Object.assign({}, parentNodeOutput);
        clonedNodeOutput.pathname = output.pathname;

        await handleNodeOutputs([clonedNodeOutput], {
          config,
          distDir,
          repoRoot,
          projectDir,
          nextVersion,
          vercelOutputDir,
        });

        const initialHeaders = Object.assign(
          {},
          output.fallback?.initialHeaders
        );

        if (
          output.fallback?.postponedState &&
          output.fallback.filePath &&
          prerenderFallbackPath
        ) {
          const fallbackHtml = await fs.readFile(
            output.fallback.filePath,
            'utf8'
          );
          await fs.writeFile(
            prerenderFallbackPath,
            `${output.fallback.postponedState}${fallbackHtml}`
          );
          initialHeaders['content-type'] =
            `application/x-nextjs-pre-render; state-length=${output.fallback.postponedState.length}; origin="text/html; charset=utf-8"`;
        }

        await fs.mkdir(path.dirname(prerenderConfigPath), { recursive: true });
        await fs.writeFile(
          prerenderConfigPath,
          JSON.stringify(
            // TODO: strongly type this
            {
              group: output.groupId,
              expiration:
                typeof output.fallback?.initialRevalidate !== 'undefined'
                  ? output.fallback?.initialRevalidate
                  : 1,

              staleExpiration: output.fallback?.initialExpiration,

              sourcePath: parentNodeOutput?.pathname,

              // send matches in query instead of x-now-route-matches
              // legacy header
              passQuery: true,
              allowQuery: output.config.allowQuery,
              allowHeader: output.config.allowHeader,

              bypassToken: output.config.bypassToken,
              experimentalBypassFor: output.config.bypassFor,

              initialHeaders,
              initialStatus: output.fallback?.initialStatus,

              fallback: prerenderFallbackPath
                ? path.posix.relative(
                    path.dirname(prerenderConfigPath),
                    prerenderFallbackPath
                  )
                : undefined,

              chain: output.pprChain
                ? {
                    ...output.pprChain,
                    outputPath: path.posix.join(
                      config.basePath || '',
                      parentNodeOutput.pathname
                    ),
                  }
                : undefined,
            },
            null,
            2
          )
        );

        if (
          output.fallback?.filePath &&
          prerenderFallbackPath &&
          // if postponed state is present we write the fallback file above
          !output.fallback.postponedState
        ) {
          // we use link to avoid copying files un-necessarily
          await fs.link(output.fallback.filePath, prerenderFallbackPath);
        }
      } catch (err) {
        console.error(`Failed to handle output:`, output);
        throw err;
      }

      fsSema.release();
    })
  );

  // If a node output was consumed by a prerender we don't want to
  // create a separate function for it
  return nodeOutputs.filter((output) => !prerenderParentIds.has(output.id));
}

type EdgeFunctionConfig = {
  runtime: 'edge';
  entrypoint: string;
  envVarsInUse?: string[];
  files: Record<string, string>;
  regions?: 'all' | string | string[];
};

export async function handleEdgeOutputs(
  edgeOutputs: FuncOutputs,
  {
    config,
    distDir,
    repoRoot,
    projectDir,
    vercelOutputDir,
  }: {
    config: NextConfig;
    distDir: string;
    repoRoot: string;
    projectDir: string;
    vercelOutputDir: string;
  }
) {
  const fsSema = new Sema(16, { capacity: edgeOutputs.length });
  const functionsDir = path.join(vercelOutputDir, 'functions');
  const handlerRelativeDir = path.posix.relative(repoRoot, projectDir);

  await Promise.all(
    edgeOutputs.map(async (output) => {
      await fsSema.acquire();

      const functionDir = path.join(
        functionsDir,
        config.basePath || '',
        `${output.pathname}.func`
      );
      await fs.mkdir(functionDir, { recursive: true });

      const files: Record<string, string> = {};

      for (const [relPath, fsPath] of Object.entries(output.assets)) {
        files[relPath] = path.posix.relative(repoRoot, fsPath);
      }
      files[path.posix.relative(projectDir, output.filePath)] =
        path.posix.relative(repoRoot, output.filePath);

      // Get file paths for the edge function source generation
      const filePaths = [
        path.posix.relative(projectDir, output.filePath),
        ...Object.keys(output.assets),
      ];

      // Create Next.js parameters for the edge function
      const params = {
        name: 'middleware', // This would typically come from the output config
        staticRoutes: [], // These would come from Next.js routing info
        dynamicRoutes: [], // These would come from Next.js routing info
        nextConfig: null, // This would come from next.config.js
      };

      // Generate the edge function source using Next.js logic
      const edgeSourceObj = await getNextjsEdgeFunctionSource(
        filePaths,
        params,
        projectDir,
        undefined // TODO: Add WASM support when available in AdapterOutput
      );

      const edgeSource = edgeSourceObj.source();

      const handlerFilePath = path.join(
        functionDir,
        handlerRelativeDir,
        'index.js'
      );
      await fs.mkdir(path.dirname(handlerFilePath), { recursive: true });
      await fs.writeFile(handlerFilePath, edgeSource);

      const edgeConfig: EdgeFunctionConfig = {
        runtime: 'edge',
        entrypoint: path.posix.join(
          path.posix.relative(repoRoot, projectDir),
          'index.js'
        ),
        files,
        envVarsInUse: undefined, // TODO: env not yet available in AdapterOutput config
        regions: output.config.preferredRegion,
      };

      await fs.writeFile(
        path.join(functionDir, '.vc-config.json'),
        JSON.stringify(edgeConfig, null, 2)
      );

      fsSema.release();
    })
  );
}
