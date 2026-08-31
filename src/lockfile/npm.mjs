/**
 * Reading package-lock.json, and answering the question a download count cannot:
 * if I delete this dependency, how much actually leaves node_modules?
 *
 * A direct dependency is the visible part. `cors` is one line in a manifest and
 * a small tree on disk, and the tree is what a supply-chain argument is actually
 * about. So this module builds the resolution graph the lockfile describes and
 * computes, for a set of packages being removed, the transitive closure that
 * becomes unreachable once they are gone - excluding everything still reachable
 * from the dependencies you are keeping.
 *
 * Lockfile v2 and v3 only (npm 7+, 2021 onward). v1 nested its tree inside
 * `dependencies` with no `packages` map; it is detected and reported as
 * unsupported rather than half-parsed.
 */

/**
 * @typedef {object} LockNode
 * @property {string} path      the node_modules path that keys this entry
 * @property {string} name      the bare package name
 * @property {string} version
 * @property {boolean} hasInstallScript  runs code at install time
 * @property {boolean} dev
 * @property {string[]} deps    names this package depends on
 * @property {string[]} peers   names this package requires as peers
 */

/** @typedef {{ nodes: Map<string, LockNode>, roots: string[], version: number }} Lock */

/**
 * @param {string} text the contents of package-lock.json
 * @returns {{ lock: Lock|null, reason: string|null }}
 */
export function parseNpmLock(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { lock: null, reason: `package-lock.json is not valid JSON: ${/** @type {Error} */ (err).message}` };
  }

  const version = Number(json.lockfileVersion ?? 0);
  if (!json.packages) {
    return {
      lock: null,
      reason: version === 1
        ? 'lockfile version 1 (npm 6) is not supported; run `npm install` with npm 7+ to upgrade it'
        : 'package-lock.json has no "packages" map',
    };
  }

  /** @type {Map<string, LockNode>} */
  const nodes = new Map();
  for (const [path, entry] of Object.entries(json.packages)) {
    if (path === '') continue; // the root project, handled below
    nodes.set(path, {
      path,
      // The last node_modules segment is the package, which keeps scoped names
      // (@scope/name) intact because the split is on the directory, not the slash.
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: String(entry.version ?? ''),
      hasInstallScript: entry.hasInstallScript === true,
      dev: entry.dev === true,
      deps: [
        ...Object.keys(entry.dependencies ?? {}),
        ...Object.keys(entry.optionalDependencies ?? {}),
      ],
      // Peers are NOT dependency edges - the consumer installs them - but they
      // are the reason a package like react-dom sits in a manifest that never
      // imports it. Kept separate so reachability stays correct.
      peers: Object.keys(entry.peerDependencies ?? {}),
    });
  }

  const root = json.packages[''] ?? {};
  const roots = [
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.devDependencies ?? {}),
    ...Object.keys(root.optionalDependencies ?? {}),
  ];

  return { lock: { nodes, roots, version }, reason: null };
}

/**
 * Resolve a dependency name from a package's position in the tree.
 *
 * npm hoists, so `a`'s dependency on `c` is usually satisfied by the top-level
 * `node_modules/c`, but may be satisfied by a nested copy when versions
 * conflict. Resolution walks outward from the importer, which is exactly what
 * Node's own resolution algorithm does.
 *
 * @param {Lock} lock
 * @param {string} fromPath
 * @param {string} name
 * @returns {string|null} the path of the resolved node
 */
export function resolveFrom(lock, fromPath, name) {
  const segments = fromPath === '' ? [] : fromPath.split('/node_modules/');
  for (let depth = segments.length; depth >= 0; depth--) {
    const prefix = segments.slice(0, depth).join('/node_modules/');
    const candidate = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
    if (lock.nodes.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Everything reachable from a set of top-level dependency names.
 * @param {Lock} lock
 * @param {Iterable<string>} names
 * @returns {Set<string>} node paths
 */
function reachable(lock, names) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const queue = [];

  for (const name of names) {
    const path = resolveFrom(lock, '', name);
    if (path) queue.push(path);
  }

  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const node = lock.nodes.get(path);
    if (!node) continue;
    for (const dep of node.deps) {
      const resolved = resolveFrom(lock, path, dep);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/**
 * What actually leaves node_modules when `removed` are deleted.
 *
 * A package still reachable from a dependency you are keeping does not count -
 * that is the difference between "cors depends on 2 packages" and "removing cors
 * removes 2 packages", and only the second one is true.
 *
 * @param {Lock} lock
 * @param {Iterable<string>} removed top-level dependency names being removed
 * @returns {{ packages: LockNode[], installScripts: LockNode[] }}
 */
export function removalImpact(lock, removed) {
  const removing = new Set(removed);
  const keeping = lock.roots.filter((name) => !removing.has(name));

  const kept = reachable(lock, keeping);
  const touched = reachable(lock, removing);

  const packages = [...touched]
    .filter((path) => !kept.has(path))
    .map((path) => lock.nodes.get(path))
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  return { packages, installScripts: packages.filter((node) => node.hasInstallScript) };
}

/**
 * Every package name some installed package requires as a peer.
 *
 * A peer dependency is declared by the manifest and imported by nobody: `next`
 * requires `react-dom`, so `react-dom` is in your dependencies and appears in
 * none of your source. An import-based scan calls that dead, and deleting it
 * breaks the build - which is exactly what shed used to do.
 *
 * @param {Lock} lock
 * @returns {Set<string>}
 */
export function peerRequirements(lock) {
  /** @type {Set<string>} */
  const required = new Set();
  for (const node of lock.nodes.values()) {
    for (const peer of node.peers) required.add(peer);
  }
  return required;
}

/**
 * For each name being removed, the surviving dependency that still requires it.
 *
 * Removing `clsx` from a manifest frees nothing if `class-variance-authority`
 * hard-depends on it: the package stays in node_modules, and the rewrite you were
 * about to do buys you no dependency reduction at all. Knowing that before you
 * start is worth more than the recommendation itself.
 *
 * @param {Lock} lock
 * @param {Iterable<string>} removed
 * @returns {Map<string, string>} removed name -> the survivor keeping it
 */
export function retainedBy(lock, removed) {
  const removing = new Set(removed);
  const keeping = lock.roots.filter((name) => !removing.has(name));

  /** @type {Map<string, string>} */
  const retained = new Map();
  for (const name of removing) {
    const path = resolveFrom(lock, '', name);
    if (!path) continue;
    for (const survivor of keeping) {
      if (reachable(lock, [survivor]).has(path)) {
        retained.set(name, survivor);
        break;
      }
    }
  }
  return retained;
}
