#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { minify as minifyHtml } from 'html-minifier-terser';
import CleanCSS from 'clean-css';
import { minify as minifyJs } from 'terser';

const dist = process.argv[2];

if (!dist) {
  console.error('Usage: node tools/minify_release.mjs <dist-dir>');
  process.exit(2);
}

const files = {
  html: ['index.html', 'reader.html'],
  css: ['css/style.css'],
  pageJs: ['js/common.js', 'js/shelf.js', 'js/reader.js'],
  workerJs: ['sw.js'],
};

for (const rel of files.html) {
  await transform(rel, async (source) => minifyHtml(source, {
    collapseBooleanAttributes: true,
    collapseWhitespace: true,
    conservativeCollapse: false,
    decodeEntities: true,
    minifyCSS: true,
    minifyJS: true,
    removeAttributeQuotes: true,
    removeComments: true,
    removeEmptyAttributes: false,
    removeOptionalTags: false,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    sortAttributes: true,
    sortClassName: false,
  }));
}

for (const rel of files.css) {
  await transform(rel, async (source) => {
    const result = new CleanCSS({
      level: {
        1: { all: true },
        2: {
          all: true,
          mergeMedia: true,
          restructureRules: true,
        },
      },
    }).minify(source);

    if (result.errors.length) {
      throw new Error(`${rel}: ${result.errors.join('; ')}`);
    }

    return result.styles;
  });
}

for (const rel of files.pageJs) {
  await transform(rel, (source) => minifyJavaScript(rel, source, false));
}

for (const rel of files.workerJs) {
  await transform(rel, (source) => minifyJavaScript(rel, source, true));
}

async function transform(rel, fn) {
  const path = join(dist, rel);
  const source = await readFile(path, 'utf8');
  const output = await fn(source);
  await writeFile(path, `${output.trim()}\n`, 'utf8');
}

async function minifyJavaScript(rel, source, toplevel) {
  const result = await minifyJs(source, {
    compress: {
      arrows: true,
      booleans_as_integers: false,
      collapse_vars: true,
      comparisons: true,
      computed_props: true,
      dead_code: true,
      defaults: true,
      drop_console: false,
      drop_debugger: true,
      hoist_funs: true,
      hoist_props: true,
      if_return: true,
      join_vars: true,
      keep_fargs: false,
      passes: 2,
      pure_getters: false,
      reduce_funcs: true,
      reduce_vars: true,
      sequences: true,
      switches: true,
      toplevel,
      unsafe: false,
      unused: true,
    },
    mangle: {
      eval: false,
      keep_classnames: false,
      keep_fnames: false,
      module: false,
      properties: false,
      reserved: pageGlobalNames(rel),
      safari10: true,
      toplevel,
    },
    format: {
      ascii_only: false,
      comments: false,
    },
    toplevel,
  });

  if (!result.code) {
    throw new Error(`${rel}: Terser produced empty output`);
  }

  return result.code;
}

function pageGlobalNames(rel) {
  if (basename(rel) === 'sw.js') return [];

  return [
    'Store',
    'Offline',
    'AppPromo',
    'Theme',
    'isStandaloneApp',
    'isExternalURL',
    'getParam',
    'throttle',
    'fetchJSON',
  ];
}
