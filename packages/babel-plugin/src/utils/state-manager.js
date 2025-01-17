/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import * as t from '@babel/types';
import type { PluginPass } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type {
  CompiledNamespaces,
  StyleXOptions as RuntimeOptions,
} from '@stylexjs/shared';
import { name } from '@stylexjs/stylex/package.json';
import path from 'path';
import type { Check } from './validate';
import * as z from './validate';
import { addDefault, addNamed } from '@babel/helper-module-imports';
import type { ImportOptions } from '@babel/helper-module-imports';
import * as pathUtils from '../babel-path-utils';

type ImportAdditionOptions = Omit<
  Partial<ImportOptions>,
  'ensureLiveReference' | 'ensureNoContext',
>;

export type ImportPathResolution =
  | false
  | ['themeNameRef' | 'filePath', string];

type ModuleResolution =
  | $ReadOnly<{
      type: 'commonJS',
      rootDir: string,
      themeFileExtension?: ?string,
    }>
  | $ReadOnly<{
      type: 'haste',
      themeFileExtension?: ?string,
    }>
  | $ReadOnly<{
      type: 'experimental_crossFileParsing',
      rootDir: string,
      themeFileExtension?: ?string,
    }>;

// eslint-disable-next-line no-unused-vars
const CheckModuleResolution: Check<ModuleResolution> = z.unionOf3(
  z.object({
    type: z.literal('commonJS'),
    rootDir: z.string(),
    themeFileExtension: z.unionOf<null | void, string>(z.nullish(), z.string()),
  }),
  z.object({
    type: z.literal('haste'),
    themeFileExtension: z.unionOf(z.nullish(), z.string()),
  }),
  z.object({
    type: z.literal('experimental_crossFileParsing'),
    rootDir: z.string(),
    themeFileExtension: z.unionOf(z.nullish(), z.string()),
  }),
);

export type StyleXOptions = $ReadOnly<{
  ...RuntimeOptions,
  importSources: $ReadOnlyArray<
    string | $ReadOnly<{ from: string, as: string }>,
  >,
  runtimeInjection: boolean | ?string | $ReadOnly<{ from: string, as: string }>,
  treeshakeCompensation?: boolean,
  genConditionalClasses: boolean,
  unstable_moduleResolution: ?ModuleResolution,
  aliases: ?$ReadOnly<{ [string]: string }>,
  ...
}>;

type StyleXStateOptions = $ReadOnly<{
  ...StyleXOptions,
  runtimeInjection: ?string | $ReadOnly<{ from: string, as: ?string }>,
  ...
}>;

const checkImportSource = z.unionOf(
  z.string(),
  z.object({
    from: z.string(),
    as: z.string(),
  }),
);
const checkImportSources: Check<StyleXOptions['importSources']> =
  z.array(checkImportSource);

const checkRuntimeInjection: Check<StyleXOptions['runtimeInjection']> =
  z.unionOf3(
    z.boolean(),
    z.string(),
    z.object({
      from: z.string(),
      as: z.string(),
    }),
  );

const DEFAULT_INJECT_PATH = '@stylexjs/stylex/lib/stylex-inject';

export default class StateManager {
  +_state: PluginPass;

  // Imports
  +importPaths: Set<string> = new Set();
  +stylexImport: Set<string> = new Set();
  +stylexPropsImport: Set<string> = new Set();
  +stylexAttrsImport: Set<string> = new Set();
  +stylexCreateImport: Set<string> = new Set();
  +stylexIncludeImport: Set<string> = new Set();
  +stylexFirstThatWorksImport: Set<string> = new Set();
  +stylexKeyframesImport: Set<string> = new Set();
  +stylexDefineVarsImport: Set<string> = new Set();
  +stylexCreateThemeImport: Set<string> = new Set();
  +stylexTypesImport: Set<string> = new Set();

  injectImportInserted: ?t.Identifier = null;

  // `stylex.create` calls
  +styleMap: Map<string, CompiledNamespaces> = new Map();
  +styleVars: Map<string, NodePath<>> = new Map();

  // resuls of `stylex.create` calls that should be kept
  +styleVarsToKeep: Set<[string, true | string, true | Array<string>]> =
    new Set();

  inStyleXCreate: boolean = false;

  +options: StyleXStateOptions;

  constructor(state: PluginPass) {
    this._state = state;
    state.file.metadata.stylex = [];

    this.options = this.setOptions(state.opts ?? {});
  }

  setOptions(options: { +[string]: mixed }): StyleXStateOptions {
    const dev: StyleXStateOptions['dev'] = z.logAndDefault(
      z.boolean(),
      options.dev ?? false,
      false,
      'options.dev',
    );

    const test: StyleXStateOptions['test'] = z.logAndDefault(
      z.boolean(),
      options.test ?? false,
      false,
      'options.test',
    );

    const configRuntimeInjection: StyleXOptions['runtimeInjection'] =
      z.logAndDefault(
        checkRuntimeInjection,
        options.runtimeInjection ?? dev,
        dev,
        'options.runtimeInjection',
      );

    // prettier-ignore
    const runtimeInjection: StyleXStateOptions['runtimeInjection'] 
      = configRuntimeInjection === true ? 
        DEFAULT_INJECT_PATH
      : configRuntimeInjection === false ? 
        undefined
      : 
        configRuntimeInjection
      ;

    const classNamePrefix: StyleXStateOptions['classNamePrefix'] =
      z.logAndDefault(
        z.string(),
        options.classNamePrefix ?? 'x',
        'x',
        'options.classNamePrefix',
      );

    const configuredImportSources: StyleXStateOptions['importSources'] =
      z.logAndDefault(
        checkImportSources,
        options.importSources ?? [],
        [],
        'options.importSources',
      );

    const importSources: StyleXStateOptions['importSources'] = [
      name,
      'stylex',
      ...configuredImportSources,
    ];

    const genConditionalClasses: StyleXStateOptions['genConditionalClasses'] =
      z.logAndDefault(
        z.boolean(),
        options.genConditionalClasses ?? false,
        false,
        'options.genConditionalClasses',
      );

    const useRemForFontSize: StyleXStateOptions['useRemForFontSize'] =
      z.logAndDefault(
        z.boolean(),
        options.useRemForFontSize ?? false,
        false,
        'options.useRemForFontSize',
      );

    const styleResolution: StyleXStateOptions['styleResolution'] =
      z.logAndDefault(
        z.unionOf3(
          z.literal('application-order'),
          z.literal('property-specificity'),
          z.literal('legacy-expand-shorthands'),
        ),
        options.styleResolution ?? 'application-order',
        'application-order',
        'options.styleResolution',
      );

    const unstable_moduleResolution: StyleXStateOptions['unstable_moduleResolution'] =
      z.logAndDefault(
        z.unionOf(z.nullish(), CheckModuleResolution),
        options.unstable_moduleResolution,
        null,
        'options.unstable_moduleResolution',
      );

    const treeshakeCompensation: StyleXStateOptions['treeshakeCompensation'] =
      z.logAndDefault(
        z.boolean(),
        options.treeshakeCompensation ?? false,
        false,
        'options.treeshakeCompensation',
      );

    const opts: StyleXStateOptions = {
      // $FlowFixMe
      aliases: options.aliases,
      dev,
      test,
      runtimeInjection,
      classNamePrefix,
      importSources,
      definedStylexCSSVariables: {},
      genConditionalClasses,
      useRemForFontSize,
      styleResolution,
      unstable_moduleResolution,
      treeshakeCompensation,
    };
    return opts;
  }

  get importPathString(): string {
    if (this.importPaths.has('@stylexjs/stylex')) {
      return '@stylexjs/stylex';
    }
    if (this.importPaths.size > 0) {
      // get the first one
      return [...this.importPaths][0];
    }
    return '@stylexjs/stylex';
  }

  get importSources(): $ReadOnlyArray<string> {
    return this.options.importSources.map((source) =>
      typeof source === 'string' ? source : source.from,
    );
  }

  importAs(source: string): null | string {
    for (const importSource of this.options.importSources) {
      if (typeof importSource !== 'string' && importSource.from === source) {
        return importSource.as;
      }
    }
    return null;
  }

  get canReferenceTheme(): boolean {
    return !!this.inStyleXCreate;
    // || this.isStyleXDefineVars
  }

  get metadata(): { [key: string]: any } {
    return this._state.file.metadata;
  }

  get runtimeInjection(): ?$ReadOnly<{ from: string, as?: ?string }> {
    if (this.options.runtimeInjection == null) {
      return null;
    }
    const runInj = this.options.runtimeInjection;
    return typeof runInj === 'string' ? { from: runInj } : runInj || null;
  }

  addNamedImport(
    statementPath: NodePath<>,
    as: string,
    from: string,
    options: ImportAdditionOptions,
  ): t.Identifier {
    const identifier = addNamed(statementPath, as, from, options);
    const programPath = getProgramPath(statementPath);
    if (programPath == null) {
      return identifier;
    }
    const bodyPath: Array<NodePath<t.Statement>> = programPath.get('body');
    let lastImportIndex = -1;
    for (let i = 0; i < bodyPath.length; i++) {
      const statement = bodyPath[i];
      if (pathUtils.isImportDeclaration(statement)) {
        lastImportIndex = i;
      }
    }
    if (lastImportIndex === -1) {
      return identifier;
    }
    const lastImport = bodyPath[lastImportIndex];
    if (lastImport == null) {
      return identifier;
    }
    const importName = statementPath.scope.generateUidIdentifier(as);

    lastImport.insertAfter(
      t.variableDeclaration('var', [
        t.variableDeclarator(importName, identifier),
      ]),
    );

    return importName;
  }

  addDefaultImport(
    statementPath: NodePath<>,
    from: string,
    options: ImportAdditionOptions,
  ): t.Identifier {
    const identifier = addDefault(statementPath, from, options);
    const programPath = getProgramPath(statementPath);
    if (programPath == null) {
      return identifier;
    }
    const bodyPath: Array<NodePath<t.Statement>> = programPath.get('body');
    let lastImportIndex = -1;
    for (let i = 0; i < bodyPath.length; i++) {
      const statement = bodyPath[i];
      if (pathUtils.isImportDeclaration(statement)) {
        lastImportIndex = i;
      }
    }
    if (lastImportIndex === -1) {
      return identifier;
    }
    const lastImport = bodyPath[lastImportIndex];
    if (lastImport == null) {
      return identifier;
    }
    const importName = statementPath.scope.generateUidIdentifier('inject');

    lastImport.insertAfter(
      t.variableDeclaration('var', [
        t.variableDeclarator(importName, identifier),
      ]),
    );

    return importName;
  }

  get isDev(): boolean {
    return !!this.options.dev;
  }

  get isTest(): boolean {
    return !!this.options.test;
  }

  get filename(): string | void {
    return this._state.filename;
  }

  get cssVars(): any {
    return this.options.definedStylexCSSVariables;
  }

  get treeshakeCompensation(): boolean {
    return !!this.options.treeshakeCompensation;
  }

  get fileNameForHashing(): null | string {
    const filename = this.filename;
    const themeFileExtension =
      this.options.unstable_moduleResolution?.themeFileExtension ?? '.stylex';

    if (
      filename == null ||
      !matchesFileSuffix(themeFileExtension)(filename) ||
      this.options.unstable_moduleResolution == null
    ) {
      return null;
    }

    switch (this.options.unstable_moduleResolution.type) {
      case 'haste':
        return path.basename(filename);
      default: {
        const rootDir = this.options.unstable_moduleResolution.rootDir;
        return path.relative(rootDir, filename);
      }
    }
  }

  importPathResolver(importPath: string): ImportPathResolution {
    const sourceFilePath = this.filename;
    if (sourceFilePath == null) {
      return false;
    }

    switch (this.options.unstable_moduleResolution?.type) {
      case 'commonJS': {
        const rootDir = this.options.unstable_moduleResolution.rootDir;
        const aliases = this.options.aliases;
        const themeFileExtension =
          this.options.unstable_moduleResolution?.themeFileExtension ??
          '.stylex';
        if (!matchesFileSuffix(themeFileExtension)(importPath)) {
          return false;
        }
        const resolvedFilePath = filePathResolver(
          importPath,
          sourceFilePath,
          aliases,
        );
        return resolvedFilePath
          ? ['themeNameRef', path.relative(rootDir, resolvedFilePath)]
          : false;
      }
      case 'haste': {
        const themeFileExtension =
          this.options.unstable_moduleResolution.themeFileExtension ??
          '.stylex';
        if (!matchesFileSuffix(themeFileExtension)(importPath)) {
          return false;
        }
        return ['themeNameRef', addFileExtension(importPath, sourceFilePath)];
      }
      case 'experimental_crossFileParsing': {
        const aliases = this.options.aliases;
        const themeFileExtension =
          this.options.unstable_moduleResolution.themeFileExtension ??
          '.stylex';
        if (!matchesFileSuffix(themeFileExtension)(importPath)) {
          return false;
        }
        const resolvedFilePath = filePathResolver(
          importPath,
          sourceFilePath,
          aliases,
        );
        return resolvedFilePath ? ['filePath', resolvedFilePath] : false;
      }
      default:
        return false;
    }
  }

  addStyle(
    style: [string, { ltr: string, rtl?: string | null }, number],
  ): void {
    this.metadata.stylex.push(style);
  }

  markComposedNamespace(
    memberExpression: [string, true | string, true | Array<string>],
  ): void {
    this.styleVarsToKeep.add(memberExpression);
  }
}

function aliasPathResolver(
  importPath: string,
  aliases: StyleXOptions['aliases'],
): [string, boolean] {
  let isAliasResolved = false;
  if (!aliases) return [importPath, isAliasResolved];
  for (const [alias, value] of Object.entries(aliases)) {
    if (alias.includes('*')) {
      const [before, after] = alias.split('*');
      if (importPath.startsWith(before) && importPath.endsWith(after)) {
        const replacementString = importPath.slice(
          before.length,
          after.length > 0 ? -after.length : undefined,
        );
        isAliasResolved = true;
        return [value[0].split('*').join(replacementString), isAliasResolved];
      }
    } else if (alias === importPath) {
      isAliasResolved = true;
      return [value[0], isAliasResolved];
    }
  }
  return [importPath, isAliasResolved];
}

// a function that resolves the absolute path of a file when given the
// relative path of the file from the source file
const filePathResolver = (
  relativeFilePath: string,
  sourceFilePath: string,
  aliases: StyleXOptions['aliases'],
): void | string => {
  const fileToLookFor = relativeFilePath; //addFileExtension(relativeFilePath, sourceFilePath);
  if (EXTENSIONS.some((ext) => fileToLookFor.endsWith(ext))) {
    try {
      const resolvedFilePath = require.resolve(fileToLookFor, {
        paths: [path.dirname(sourceFilePath)],
      });
      return resolvedFilePath;
    } catch {}
  }
  for (const ext of EXTENSIONS) {
    try {
      const importPathStr = fileToLookFor.startsWith('.')
        ? fileToLookFor + ext
        : fileToLookFor;
      let aliasedImportPathStr = importPathStr;
      let isAliasResolved = false;
      if (aliases) {
        [aliasedImportPathStr, isAliasResolved] = aliasPathResolver(
          aliasedImportPathStr,
          aliases,
        );
      }
      if (isAliasResolved && aliasedImportPathStr.startsWith('.')) {
        aliasedImportPathStr += ext; // attach extension to the resolved alias import path.
      }

      const resolvedFilePath = isAliasResolved //Check if the alias is resolved and the path is valid
        ? require.resolve(path.resolve(aliasedImportPathStr), {
            paths: [path.dirname(sourceFilePath)],
          })
        : require.resolve(aliasedImportPathStr, {
            paths: [path.dirname(sourceFilePath)],
          });

      return resolvedFilePath;
    } catch {}
  }
};

const EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs'];

const addFileExtension = (
  importedFilePath: string,
  sourceFile: string,
): string => {
  if (EXTENSIONS.some((ext) => importedFilePath.endsWith(ext))) {
    return importedFilePath;
  }
  const fileExtension = path.extname(sourceFile);
  return importedFilePath + fileExtension;
};

const matchesFileSuffix = (allowedSuffix: string) => (filename: string) =>
  filename.endsWith(`${allowedSuffix}.js`) ||
  filename.endsWith(`${allowedSuffix}.ts`) ||
  filename.endsWith(`${allowedSuffix}.tsx`) ||
  filename.endsWith(`${allowedSuffix}.jsx`) ||
  filename.endsWith(`${allowedSuffix}.mjs`) ||
  filename.endsWith(`${allowedSuffix}.cjs`) ||
  filename.endsWith(allowedSuffix);

const getProgramPath = (path: NodePath<>): null | NodePath<t.Program> => {
  let programPath = path;
  while (programPath != null && !pathUtils.isProgram(programPath)) {
    if (programPath.parentPath) {
      programPath = programPath.parentPath;
    } else {
      return null;
    }
  }
  return programPath;
};
