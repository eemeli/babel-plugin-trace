import fspath from "path";

type Plugin = {
  visitor: Visitors
};

type PluginParams = {
  types: Object;
  template: (source: string) => Template;
};

type PluginOptions = {
  aliases?: {
    [key: string]: string|Template;
  };
  strip?: boolean|string|{[key: string]: boolean};
};

type Visitors = {
  [key: string]: Visitor
};

type Template = (ids: TemplateIds) => Node;
type TemplateIds = {[key: string]: Node};

type Visitor = (path: NodePath) => void;

type Node = {
  type: string;
  node?: void;
};

type Literal = {
  type: 'StringLiteral' | 'BooleanLiteral' | 'NumericLiteral' | 'NullLiteral' | 'RegExpLiteral'
};

type Identifier = {
  type: string;
  name: string;
};

type Scope = {};

type NodePath = {
  type: string;
  node: Node;
  scope: Scope;
};

type Metadata = {
  indent: number;
  prefix: string;
  parentName: string;
  filename: string;
  dirname: string;
  basename: string;
  extname: string;
  hasStartMessage: boolean;
  isStartMessage: boolean;
};

type Message = {
  prefix: Literal;
  indent: Literal;
  parentName: Literal;
  filename: Literal;
  dirname: Literal;
  basename: Literal;
  extname: Literal;
  content: Node;
};

const $handled = Symbol('handled');
const $normalized = Symbol('normalized');

/**
 * # Trace
 */
export default function ({types: t, template}: PluginParams): Plugin {

  const PRESERVE_CONTEXTS = normalizeEnv(process.env.TRACE_CONTEXT);
  const PRESERVE_FILES = normalizeEnv(process.env.TRACE_FILE);
  const PRESERVE_LEVELS = normalizeEnv(process.env.TRACE_LEVEL);

  /**
   * Normalize an environment variable, used to override plugin options.
   */
  function normalizeEnv (input: ?string): string[] {
    if (!input) {
      return [];
    }
    return input.split(/\s*,\s*/)
                .map(context => context.toLowerCase().trim())
                .filter(id => id);
  }

  /**
   * Like `template()` but returns an expression, not an expression statement.
   */
  function expression (input: string): Template {
    const fn: Template = template(input);
    return function (ids: TemplateIds): Node {
      const node: Node = fn(ids);
      return node.expression ? node.expression : node;
    };
  }

  /**
   * Normalize the plugin options.
   */
  function normalizeOpts (opts: PluginOptions): PluginOptions {
    if (opts[$normalized]) {
      return opts;
    }
    if (!opts.aliases) {
      opts.aliases = {
        log: defaultLog,
        trace: defaultLog,
        warn: defaultLog
      };
    }
    else {
      Object.keys(opts.aliases).forEach(key => {
        if (typeof opts.aliases[key] === 'string' && opts.aliases[key]) {
          const expr: ((message: Message) => Node) = expression(opts.aliases[key]);
          opts.aliases[key] = (message: Message): Node => expr(message);
        }
      });
    }
    opts[$normalized] = true;
    return opts;
  }

  /**
   * The default log() function.
   */
  function defaultLog (message: Message, metadata: Metadata): Node {
    let prefix: string = `${metadata.context}:`;
    if (metadata.indent) {
      prefix += (new Array(metadata.indent + 1)).join('  ');
    }
    if (t.isSequenceExpression(message.content)) {
      return t.callExpression(
        t.memberExpression(
          t.identifier('console'),
          t.identifier('log')
        ),
        [t.stringLiteral(prefix)].concat(message.content.expressions)
      );
    }
    else {
      return expression(`console.log(PREFIX, CONTENT)`)({
        PREFIX: t.stringLiteral(prefix),
        CONTENT: message.content
      });
    }
  }

  function generatePrefix (dirname: string, basename: string): string {
    if (basename !== 'index') {
      return basename;
    }
    basename = fspath.basename(dirname);
    if (basename !== 'src' && basename !== 'lib') {
      return basename;
    }

    return fspath.basename(fspath.dirname(dirname));
  }

  /**
   * Collect the metadata for a given node path, which will be
   * made available to logging functions.
   */
  function collectMetadata (path: NodePath, opts: PluginOptions): Metadata {
    const filename: string = fspath.resolve(process.cwd(), path.hub.file.opts.filename);
    const dirname: string = fspath.dirname(filename);
    const extname: string = fspath.extname(filename);
    const basename: string = fspath.basename(filename, extname);
    const prefix: string = generatePrefix(dirname, basename);
    const names: string[] = [];
    let indent: number = 0;
    let parent: ?NodePath;

    const parentName: string = path.getAncestry().slice(1).reduce((parts: string[], item: NodePath) => {
      if (item.isClassMethod()) {
        if (!parent) {
          parent = item;
        }
        parts.unshift(item.node.key.type === 'Identifier' ? item.node.key.name : '[computed method]');
      }
      else if (item.isClassDeclaration()) {
        if (!parent) {
          parent = item;
        }
        parts.unshift(item.node.id ? item.node.id.name : `[anonymous class@${item.node.loc.start.line}]`);
      }
      else if (item.isFunction()) {
        if (!parent) {
          parent = item;
        }
        parts.unshift((item.node.id && item.node.id.name) || `[anonymous@${item.node.loc.start.line}]`);
      }
      else if (item.isProgram()) {
        if (!parent) {
          parent = item;
        }
      }
      else if (!parent && !item.isClassBody() && !item.isBlockStatement()) {
        indent++;
      }
      return parts;
    }, []).join(':');

    let hasStartMessage: boolean = false;
    let isStartMessage: boolean = false;
    if (parent && !parent.isProgram()) {
      for (let child: NodePath of parent.get('body').get('body')) {
        if (child.node[$handled]) {
          hasStartMessage = true;
          break;
        }
        if (!child.isLabeledStatement()) {
          break;
        }
        const label: NodePath = child.get('label');
        if (opts.aliases[label.node.name]) {
          hasStartMessage = true;
          if (child.node === path.node) {
            isStartMessage = true;
          }
          break;
        }
      }
    }

    const context: string = `${prefix}:${parentName}`;
    return {indent, prefix, parentName, context, hasStartMessage, isStartMessage, filename, dirname, basename, extname};
  }


  /**
   * Determine whether the given logging statement should be stripped.
   */
  function shouldStrip (name: string, metadata: Metadata, opts: PluginOptions): boolean {
    if (!opts.strip) {
      return false;
    }
    else if (opts.strip === true) {
      return !hasStripOverride(name, metadata);
    }
    else if (typeof opts.strip === 'string') {
      if (opts.strip === process.env.NODE_ENV) {
        return !hasStripOverride(name, metadata);
      }
    }
    else if (opts.strip[process.env.NODE_ENV]) {
      return !hasStripOverride(name, metadata);
    }
    return true;
  }

  function hasStripOverride (name: string, metadata: Metadata) {
    if (PRESERVE_CONTEXTS.length && PRESERVE_CONTEXTS.some(context => metadata.context.toLowerCase().indexOf(context) !== -1)) {
      return true;
    }
    else if (PRESERVE_FILES.length && PRESERVE_FILES.some(filename => metadata.filename.toLowerCase().indexOf(filename) !== -1)) {
      return true;
    }
    else if (PRESERVE_LEVELS.length && PRESERVE_LEVELS.some(level => level === name.toLowerCase())) {
      return true;
    }
    else {
      return false;
    }
  }



  return {
    visitor: {
      Program (program: NodePath, {opts}) {
        program.traverse({
          LabeledStatement (path: NodePath): void {
            const label: NodePath = path.get('label');
            opts = normalizeOpts(opts);
            if (!opts.aliases[label.node.name]) {
              return;
            }

            const metadata: Metadata = collectMetadata(path, opts);
            if (shouldStrip(label.node.name, metadata, opts)) {
              path.remove();
              return;
            }

            path.traverse({
              "VariableDeclaration|Function|AssignmentExpression|UpdateExpression|YieldExpression|ReturnStatement" (item: NodePath): void {
                throw path.buildCodeFrameError(`Logging statements cannot have side effects.`);
              },
              ExpressionStatement (statement: NodePath): void {
                if (statement.node[$handled]) {
                  return;
                }
                const message: Message = {
                  prefix: t.stringLiteral(metadata.prefix),
                  content: statement.get('expression').node,
                  hasStartMessage: t.booleanLiteral(metadata.hasStartMessage),
                  isStartMessage: t.booleanLiteral(metadata.isStartMessage),
                  indent: t.numericLiteral(metadata.indent),
                  parentName: t.stringLiteral(metadata.parentName),
                  filename: t.stringLiteral(metadata.filename),
                  dirname: t.stringLiteral(metadata.dirname),
                  basename: t.stringLiteral(metadata.basename),
                  extname: t.stringLiteral(metadata.extname)
                };
                const replacement = t.expressionStatement(opts.aliases[label.node.name](message, metadata));
                replacement[$handled] = true;
                statement.replaceWith(replacement);
              }
            });

            if (path.get('body').isBlockStatement()) {
              path.replaceWithMultiple(path.get('body').node.body);
            }
            else {
              path.replaceWith(path.get('body').node);
            }
          }
        });
      }

    }
  };
}
