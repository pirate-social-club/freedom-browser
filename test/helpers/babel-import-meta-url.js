/**
 * Jest runs every module through Babel as CommonJS, where `import.meta` is a
 * syntax error. libveritas's wasm-bindgen glue
 * (`@spacesprotocol/libveritas/libveritas.js`) reads `import.meta.url` only to
 * find its .wasm when initialised without bytes, which Freedom never does
 * (src/main/spaces/veritas.js passes them). This rewrites the expression to its
 * CommonJS equivalent so the glue loads under Jest; babel.config.json applies
 * it to that package alone. The app itself never runs through Babel.
 */
module.exports = function importMetaUrl({ types: t, template }) {
  const replacement = template.expression("require('url').pathToFileURL(__filename).href");
  return {
    name: 'import-meta-url',
    visitor: {
      MemberExpression(path) {
        const { object, property } = path.node;
        if (
          t.isMetaProperty(object) &&
          object.meta.name === 'import' &&
          object.property.name === 'meta' &&
          t.isIdentifier(property, { name: 'url' }) &&
          !path.node.computed
        ) {
          path.replaceWith(replacement());
        }
      },
    },
  };
};
